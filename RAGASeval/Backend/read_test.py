from raga_database import SessionLocal
from raga_models import Evaluation

db = SessionLocal()

rows = db.query(Evaluation).all()

for row in rows:
    print(row.id, row.query, row.faithfulness, row.created_at)

db.close()