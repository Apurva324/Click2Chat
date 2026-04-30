from sqlalchemy import Column, Integer, String, Float, DateTime
from datetime import datetime
from RAGASeval.Backend.raga_database import Base

class Evaluation(Base):
    __tablename__ = "evaluations"

    id = Column(Integer, primary_key=True, index=True)
    query = Column(String, nullable=False)
    answer = Column(String, nullable=False)

    faithfulness = Column(Float, nullable=True)
    answer_relevancy = Column(Float, nullable=True)
    context_precision = Column(Float, nullable=True)
    latency = Column(Float, default=0.0)

    created_at = Column(DateTime, default=datetime.utcnow)