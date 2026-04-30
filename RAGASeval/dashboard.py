import streamlit as st
import pandas as pd
import sqlite3
import plotly.express as px
import os
import time
import requests

st.set_page_config(page_title="RAG Dashboard", layout="wide")

st.title("Live RAG Evaluation Dashboard")

# Always points to RAGAS/Backend/rag_dashboard.db regardless of where streamlit is run from
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "Backend", "rag_dashboard.db")

# Auto-refresh every 5 seconds so new queries appear without manual reload
st.caption(f"Auto-refreshing every 5 seconds • DB: {DB_PATH}")

# Connect DB
# new starts
API_URL = "http://127.0.0.1:8000/evaluations"  # change later to Railway URL

response = requests.get(API_URL)

if response.status_code == 200:
    df = pd.DataFrame(response.json())
else:
    st.error("Failed to fetch data from API")
    df = pd.DataFrame()
# new ends

if df.empty:
    st.warning("No data found.")
else:
    # KPIs
    col1, col2, col3, col4 = st.columns(4)

    col1.metric("Total Queries", len(df))
    col2.metric("Avg Faithfulness", round(df["faithfulness"].dropna().mean(), 2) if df["faithfulness"].notna().any() else "pending")
    col3.metric("Avg Relevancy", round(df["answer_relevancy"].dropna().mean(), 2) if df["answer_relevancy"].notna().any() else "pending")
    col4.metric("Avg Latency", round(df["latency"].mean(), 2))

    st.divider()

    # Table
    st.subheader("Recent Evaluations")
    st.dataframe(df.sort_values("id", ascending=False), use_container_width=True)

    st.divider()

    # Chart 1
    st.subheader("Faithfulness Trend")
    fig1 = px.line(df, x="id", y="faithfulness", markers=True)
    st.plotly_chart(fig1, use_container_width=True)

    # Chart 2
    st.subheader("Latency Trend")
    fig2 = px.bar(df, x="id", y="latency")
    st.plotly_chart(fig2, use_container_width=True)

# Auto-refresh every 5 seconds
time.sleep(5)
st.rerun()