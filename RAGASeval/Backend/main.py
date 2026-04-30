from fastapi import FastAPI
from pydantic import BaseModel
from raga_database import SessionLocal
from raga_models import Evaluation
import random
import time

app = FastAPI()

class QueryRequest(BaseModel):
    query: str

@app.get("/")
def home():
    return {"message": "RAG Backend Running"}

@app.post("/ask")
def ask_question(data: QueryRequest):
    start = time.time()

    query = data.query

    # Mock RAG Answer
    answer = f"Answer for: {query}"

    # Mock Evaluation Scores
    faithfulness = round(random.uniform(0.7, 1.0), 2)
    answer_relevancy = round(random.uniform(0.7, 1.0), 2)
    context_precision = round(random.uniform(0.7, 1.0), 2)

    latency = round(time.time() - start, 2)

    db = SessionLocal()

    row = Evaluation(
        query=query,
        answer=answer,
        faithfulness=faithfulness,
        answer_relevancy=answer_relevancy,
        context_precision=context_precision,
        latency=latency
    )

    db.add(row)
    db.commit()
    db.close()

    return {
        "query": query,
        "answer": answer,
        "faithfulness": faithfulness,
        "answer_relevancy": answer_relevancy,
        "context_precision": context_precision,
        "latency": latency
    }