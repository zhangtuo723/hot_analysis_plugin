from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.database import engine, Base
from app.models.analyze import AnalyzeLog, Conversation  # noqa: F401
from app.routers import analyze
from app.agent.ws import browser_manager
from app.agent.agent import close_checkpointer

Base.metadata.create_all(bind=engine)

# 确保报告目录存在
REPORTS_DIR = Path(__file__).resolve().parent.parent / "workspace" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    # 收到 SIGINT/SIGTERM 后执行清理
    await browser_manager.close_all()
    await close_checkpointer()
    engine.dispose()


app = FastAPI(title="小红书爆款分析 API", version="0.3.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(analyze.router)
app.mount("/reports", StaticFiles(directory=str(REPORTS_DIR)), name="reports")


@app.get("/")
def root():
    return {"message": "小红书爆款分析 API 运行中"}
