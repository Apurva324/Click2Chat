from raga_database import SessionLocal
from raga_models import Evaluation

db = SessionLocal()

new_record = Evaluation(
    query="What is RAG?",
    answer="RAG stands for Retrieval-Augmented Generation.",
    faithfulness=0.92,
    answer_relevancy=0.95,
    context_precision=0.88,
    latency=1.34
)

db.add(new_record)
db.commit()
db.close()

print("Dummy record inserted successfully!")