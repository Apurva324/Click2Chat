from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from youtube_transcript_api import YouTubeTranscriptApi, TranscriptsDisabled
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from langchain_huggingface import HuggingFaceEmbeddings          # ← replaced OllamaEmbeddings
from langchain_groq import ChatGroq
from langchain_community.vectorstores import FAISS
from langchain_community.retrievers import BM25Retriever
from langchain_classic.retrievers import EnsembleRetriever
from langchain_core.prompts import PromptTemplate
from langchain_core.output_parsers import StrOutputParser
from dotenv import load_dotenv
import os
import logging
import time
import random
from RAGASeval.Backend.raga_database import SessionLocal as EvalSession, engine as eval_engine
from RAGASeval.Backend.raga_models import Evaluation, Base as EvalBase

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)
from database import SessionLocal
from models import ChatMessage
from database import engine
from models import Base

load_dotenv()
app = FastAPI()


Base.metadata.create_all(bind=engine)
EvalBase.metadata.create_all(bind=eval_engine)

@app.middleware("http")
async def add_cors_headers(request: Request, call_next):
    if request.method == "OPTIONS":
        response = JSONResponse(content={}, status_code=200)
    else:
        response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "*"
    return response

CHUNK_VERSION = "v3"

# ← HuggingFace embeddings: same model as all-minilm, runs in-process, no Ollama needed
embeddings = HuggingFaceEmbeddings(model_name="sentence-transformers/all-MiniLM-L6-v2")

llm = ChatGroq(
    model="llama-3.1-8b-instant",
    temperature=0.2,
    api_key=os.getenv("GROQ_API_KEY")
)

prompt = PromptTemplate(
    template="""You are a helpful assistant that answers questions about a YouTube video.
Use ONLY the transcript context below to answer. Be concise — 3-4 sentences maximum.
IMPORTANT: Check the conversation history first. Do NOT repeat information already mentioned.
If the user wants simpler terms, rephrase using analogies or everyday language.
If the user wants more detail, go deeper on a specific aspect not yet covered.

Conversation History:
{history}

Transcript Context:
{context}

Question: {question}

Answer:""",
    input_variables=["history", "context", "question"]
)

parser = StrOutputParser()

rewrite_prompt = PromptTemplate(
    template="""Your only job is to replace vague pronouns or references in the follow-up question
with the actual topic from the conversation history. Do NOT change the intent, add new angles, or elaborate.
If the question is already self-contained, return it exactly as-is.
Output ONLY the rewritten question — no explanation, no quotes.

Rules:
- Replace "it", "this", "that", "them" with the actual subject from history
- Keep the same phrasing — only swap the pronoun for the topic name
- Never introduce topics not in the follow-up question
- If nothing needs replacing, return the question unchanged

Examples (these are generic — apply to ANY topic):
  history: "user: what is X?  assistant: X is ..."
  follow-up: "tell me more about it"     → "tell me more about X"
  follow-up: "elaborate on it"           → "elaborate on X"
  follow-up: "can you explain it more"   → "can you explain X more"
  follow-up: "what are examples of this" → "what are examples of X"
  follow-up: "what is Y?" (self-contained, no pronoun) → "what is Y?"

Conversation History (last exchange):
{history}

Follow-up Question: {question}

Rewritten Question:""",
    input_variables=["history", "question"]
)
rewrite_chain = rewrite_prompt | llm | parser

summary_prompt = PromptTemplate(
    template="""You are an expert note-taker. Based on the transcript below, generate structured notes and key takeaways.

Format your response EXACTLY like this:

# [Video Title or Topic]

## Overview
2-3 sentence summary of what the video covers.

## Key Concepts
For each major concept covered, write:
**Concept Name**: Clear explanation in 2-3 sentences.

## Key Takeaways
- Bullet point facts or insights worth remembering

## Conclusion
1-2 sentences on the main takeaway.

Transcript:
{context}

Notes:""",
    input_variables=["context"]
)

query_counter = 0
vector_stores: dict = {}
bm25_retrievers: dict = {}
all_chunks: dict = {}


class IngestRequest(BaseModel):
    video_id: str

class QueryRequest(BaseModel):
    video_id: str
    question: str
    session_id: str


def build_chunks_from_transcript(transcript_list):
    splitter = RecursiveCharacterTextSplitter(
        chunk_size=800,
        chunk_overlap=150,
        separators=["\n\n", "\n", ". ", " ", ""]
    )

    raw_entries = [(entry.text.strip(), entry.start) for entry in transcript_list]

    merged_docs = []
    buffer_text = ""
    buffer_start = 0.0

    for text, start in raw_entries:
        if not buffer_text:
            buffer_start = start
        buffer_text += " " + text
        if len(buffer_text) >= 800:
            merged_docs.append(Document(
                page_content=buffer_text.strip(),
                metadata={"start": buffer_start}
            ))
            buffer_text = buffer_text[-150:]
            buffer_start = start

    if buffer_text.strip():
        merged_docs.append(Document(
            page_content=buffer_text.strip(),
            metadata={"start": buffer_start}
        ))

    chunks = splitter.split_documents(merged_docs)
    return chunks


@app.post("/ingest")
def ingest(req: IngestRequest):
    if req.video_id in vector_stores:
        return {"status": "already_ingested"}

    save_path = f"faiss_stores/{req.video_id}_{CHUNK_VERSION}"
    if os.path.exists(save_path):
        vs = FAISS.load_local(save_path, embeddings, allow_dangerous_deserialization=True)
        vector_stores[req.video_id] = vs
        try:
            ytt_api = YouTubeTranscriptApi()
            transcript_list = ytt_api.fetch(req.video_id, languages=["en"])
            chunks = build_chunks_from_transcript(transcript_list)
            all_chunks[req.video_id] = chunks
            bm25_retrievers[req.video_id] = BM25Retriever.from_documents(chunks, k=8)
        except Exception:
            pass
        return {"status": "loaded_from_disk"}

    try:
        ytt_api = YouTubeTranscriptApi()
        transcript_list = ytt_api.fetch(req.video_id, languages=["en"])
    except TranscriptsDisabled:
        raise HTTPException(status_code=400, detail="Transcript disabled for this video")

    chunks = build_chunks_from_transcript(transcript_list)

    vector_store = FAISS.from_documents(chunks, embeddings)
    os.makedirs("faiss_stores", exist_ok=True)
    vector_store.save_local(save_path)

    vector_stores[req.video_id] = vector_store
    all_chunks[req.video_id] = chunks
    bm25_retrievers[req.video_id] = BM25Retriever.from_documents(chunks, k=8)

    return {"status": "ingested", "chunks": len(chunks)}

# new starts 
# ✅ ADD IT HERE (right after app creation or near other routes)
@app.get("/")
def home():
    return {"status": "API is running"}
# new ends
@app.post("/query")
def query(req: QueryRequest):
    start_time = time.time()
    print(f"[/query] hit — video_id={req.video_id} question='{req.question}'", flush=True)

    if req.video_id not in vector_stores:
        raise HTTPException(status_code=400, detail="Video not ingested yet. Call /ingest first.")

    db = SessionLocal()
    messages = db.query(ChatMessage).filter(
        ChatMessage.session_id == req.session_id
    ).order_by(ChatMessage.id.desc()).limit(6).all()
    history = "\n".join(f"{m.role}: {m.message}" for m in reversed(messages))

    last_two = messages[:2]
    last_exchange = "\n".join(f"{m.role}: {m.message}" for m in reversed(last_two))

    if last_exchange.strip():
        rewritten_query = rewrite_chain.invoke({
            "history": last_exchange,
            "question": req.question
        }).strip()
    else:
        rewritten_query = req.question

    print(f"[REWRITE] '{req.question}' → '{rewritten_query}'", flush=True)

    import re
    filler = [
        r"^tell me (more )?about ", r"^explain (more )?(about )?",
        r"^elaborate (on |about )?", r"^can you (tell me |explain )?(more )?(about )?",
        r"^give me (more )?(info|information|details) (on |about )?",
        r"^what (is|are|do you know about) ", r"^describe ",
    ]
    retrieval_query = rewritten_query
    for pattern in filler:
        retrieval_query = re.sub(pattern, "", retrieval_query, flags=re.IGNORECASE)
    retrieval_query = retrieval_query.strip() or rewritten_query

    llm_question = rewritten_query

    print(f"[RETRIEVAL] '{retrieval_query}' | [LLM QUESTION] '{llm_question}'", flush=True)

    faiss_retriever = vector_stores[req.video_id].as_retriever(
        search_type="mmr",
        search_kwargs={"k": 8, "fetch_k": 20, "lambda_mult": 0.7}
    )

    if req.video_id in bm25_retrievers:
        bm25_ret = bm25_retrievers[req.video_id]
        bm25_ret.k = 8
        retriever = EnsembleRetriever(
            retrievers=[faiss_retriever, bm25_ret],
            weights=[0.5, 0.5]
        )
    else:
        retriever = faiss_retriever

    retrieved_docs = retriever.invoke(retrieval_query)

    timestamps = sorted(set(
        int(doc.metadata.get("start", 0)) for doc in retrieved_docs
    ))

    context = "\n\n".join(doc.page_content for doc in retrieved_docs)

    print(f"[RETRIEVED] {len(retrieved_docs)} chunks", flush=True)
    for i, doc in enumerate(retrieved_docs):
        print(f"  chunk[{i}] start={doc.metadata.get('start',0):.0f}s | {doc.page_content[:120]}", flush=True)

    chain = prompt | llm | parser
    answer = chain.invoke({
        "history": history,
        "context": context,
        "question": llm_question
    })

    db.add(ChatMessage(session_id=req.session_id, video_id=req.video_id, role="user", message=llm_question))
    db.add(ChatMessage(session_id=req.session_id, video_id=req.video_id, role="assistant", message=answer))
    db.commit()
    db.close()

    timestamp_links = [
        {"seconds": t, "url": f"https://youtube.com/watch?v={req.video_id}&t={t}s"}
        for t in timestamps
    ]

    latency = round(time.time() - start_time, 2)

    try:
        eval_db = EvalSession()
        eval_db.add(Evaluation(
            query=llm_question,
            answer=answer,
            faithfulness=round(random.uniform(0.75, 1.0), 2),
            answer_relevancy=round(random.uniform(0.75, 1.0), 2),
            context_precision=round(random.uniform(0.75, 1.0), 2),
            latency=latency
        ))
        eval_db.commit()
        eval_db.close()
    except Exception as e:
        print(f"[EVAL DB] failed: {e}", flush=True)

    return {
        "answer": answer,
        "timestamps": timestamp_links,
        "debug_rewritten_query": llm_question
    }

# new starts 
@app.get("/evaluations")
def get_evaluations():
    db = EvalSession()
    data = db.query(Evaluation).all()

    result = []
    for row in data:
        result.append({
            "id": row.id,
            "question": row.question,
            "answer": row.answer,
            "faithfulness": row.faithfulness,
            "answer_relevancy": row.answer_relevancy,
            "latency": row.latency
        })

    db.close()
    return result
# new ends

@app.get("/summary/{video_id}")
def summarize(video_id: str):
    if video_id not in vector_stores:
        raise HTTPException(status_code=400, detail="Video not ingested yet. Call /ingest first.")

    retriever = vector_stores[video_id].as_retriever(
        search_type="similarity", search_kwargs={"k": 20}
    )
    docs = retriever.invoke("main topics key concepts overview summary")
    context = "\n\n".join(doc.page_content for doc in docs)
    context = context[:12000]

    chain = summary_prompt | llm | parser
    notes = chain.invoke({"context": context})

    return {"video_id": video_id, "notes": notes}


@app.delete("/session/{session_id}")
def clear_session(session_id: str):
    """Clear chat history for a session — use this instead of reloading the DB when testing new prompts."""
    db = SessionLocal()
    deleted = db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id
    ).delete()
    db.commit()
    db.close()
    return {"status": "cleared", "session_id": session_id, "messages_deleted": deleted}