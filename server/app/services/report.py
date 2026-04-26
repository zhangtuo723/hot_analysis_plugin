"""报告生成器 - 将 Markdown 内容转为可视化 HTML 页面"""

from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path

import markdown

REPORTS_DIR = Path(__file__).resolve().parent.parent.parent / "workspace" / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

HTML_TEMPLATE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{title}</title>
  <style>
    :root {{
      --red: #ff2442;
      --red-light: #fff0f2;
      --text: #333;
      --text-secondary: #666;
      --bg: #f5f5f5;
      --card-bg: #fff;
      --border: #eee;
    }}
    * {{ margin: 0; padding: 0; box-sizing: border-box; }}
    body {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.7;
    }}
    .header {{
      background: linear-gradient(135deg, #ff2442 0%, #ff6b7a 100%);
      color: #fff;
      padding: 40px 20px;
      text-align: center;
    }}
    .header h1 {{ font-size: 24px; font-weight: 700; margin-bottom: 8px; }}
    .header .meta {{ font-size: 13px; opacity: 0.9; }}
    .container {{
      max-width: 800px;
      margin: 0 auto;
      padding: 30px 20px;
    }}
    .card {{
      background: var(--card-bg);
      border-radius: 12px;
      padding: 30px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.06);
    }}
    .card h2 {{
      font-size: 18px;
      color: var(--red);
      margin: 24px 0 12px;
      padding-bottom: 8px;
      border-bottom: 2px solid var(--red-light);
    }}
    .card h2:first-child {{ margin-top: 0; }}
    .card h3 {{
      font-size: 15px;
      color: var(--text);
      margin: 16px 0 8px;
    }}
    .card p {{ margin-bottom: 12px; color: var(--text-secondary); }}
    .card ul, .card ol {{
      margin: 12px 0 12px 20px;
      color: var(--text-secondary);
    }}
    .card li {{ margin-bottom: 8px; }}
    .card strong {{ color: var(--text); }}
    .card blockquote {{
      border-left: 4px solid var(--red);
      padding: 12px 16px;
      margin: 16px 0;
      background: var(--red-light);
      border-radius: 0 8px 8px 0;
      color: var(--text);
    }}
    .card code {{
      background: #f4f4f5;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
      font-family: "SF Mono", Monaco, monospace;
    }}
    .card pre {{
      background: #1e1e2e;
      color: #cdd6f4;
      padding: 16px;
      border-radius: 8px;
      overflow-x: auto;
      font-size: 13px;
      margin: 12px 0;
    }}
    .card pre code {{
      background: none;
      padding: 0;
      color: inherit;
    }}
    .card table {{
      width: 100%;
      border-collapse: collapse;
      margin: 16px 0;
      font-size: 14px;
    }}
    .card th, .card td {{
      padding: 10px 12px;
      border: 1px solid var(--border);
      text-align: left;
    }}
    .card th {{
      background: var(--red-light);
      color: var(--red);
      font-weight: 600;
    }}
    .footer {{
      text-align: center;
      padding: 30px 20px;
      font-size: 12px;
      color: #999;
    }}
    @media (max-width: 600px) {{
      .header h1 {{ font-size: 20px; }}
      .card {{ padding: 20px; }}
    }}
  </style>
</head>
<body>
  <div class="header">
    <h1>{title}</h1>
    <div class="meta">生成时间：{time} · 小红书爆款分析助手</div>
  </div>
  <div class="container">
    <div class="card">
      {content}
    </div>
  </div>
  <div class="footer">
    由 AI Agent 自动生成 · 数据仅供参考
  </div>
</body>
</html>
"""


def generate_html_report(title: str, content: str, fmt: str = "md") -> str:
    """生成 HTML 报告文件，返回可访问的文件名。

    Args:
        title: 报告标题
        content: 报告内容。fmt="md" 时为 Markdown，fmt="html" 时为原始 HTML。
        fmt: 内容格式，"md" 或 "html"。默认 "md"。

    Returns:
        生成的 HTML 文件名，如 "report_xxx.html"
    """
    if fmt == "html":
        html_body = content
    else:
        html_body = markdown.markdown(
            content,
            extensions=["tables", "fenced_code", "nl2br"],
        )

    filename = f"report_{uuid.uuid4().hex[:8]}.html"
    filepath = REPORTS_DIR / filename

    if fmt == "html":
        # 传入的已是完整 HTML，直接写入，不套模板
        filepath.write_text(content, encoding="utf-8")
    else:
        html = HTML_TEMPLATE.format(
            title=title,
            time=datetime.now().strftime("%Y-%m-%d %H:%M"),
            content=html_body,
        )
        filepath.write_text(html, encoding="utf-8")

    return filename
