from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.database import engine, Base
from app.models.analyze import AnalyzeLog, Conversation  # noqa: F401
from app.routers import analyze

Base.metadata.create_all(bind=engine)

app = FastAPI(title="小红书爆款分析 API", version="0.3.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analyze.router)


@app.get("/")
def root():
    return {"message": "小红书爆款分析 API 运行中"}
