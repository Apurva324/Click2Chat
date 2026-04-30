from sqlalchemy import Column, Integer, String, Text, DateTime
from datetime import datetime
from database import Base
from datetime import datetime, timezone

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(String, index=True)
    video_id = Column(String, index=True)
    role = Column(String)      # user / assistant
    message = Column(Text)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))