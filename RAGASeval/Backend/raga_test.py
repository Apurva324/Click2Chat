from raga_database import engine
from raga_models import Base

Base.metadata.create_all(bind=engine)

print("Database and table created successfully!")