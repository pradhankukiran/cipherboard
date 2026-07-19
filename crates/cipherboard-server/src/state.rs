use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::Message;
use dashmap::DashMap;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::sync::{broadcast, RwLock};

use crate::config::Config;
use crate::protocol::ServerMessage;
use crate::rate_limit::RateLimiter;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub config: Config,
    /// room_id -> broadcast of serialized ServerMessage
    pub rooms: Arc<DashMap<String, broadcast::Sender<String>>>,
    /// participant session tokens: token -> Session
    pub sessions: Arc<DashMap<String, Session>>,
    /// per-connection rate limiters keyed by participant_id
    pub rate_limits: Arc<DashMap<String, Arc<RateLimiter>>>,
    /// room seq counters
    pub seqs: Arc<RwLock<HashMap<(String, String), u64>>>,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub participant_id: String,
    pub room_id: String,
    pub role: String,
    pub status: String,
}

impl AppState {
    pub async fn connect(config: &Config) -> anyhow::Result<Self> {
        let db = PgPoolOptions::new()
            .max_connections(10)
            .connect(&config.database_url)
            .await?;
        Ok(Self {
            db,
            config: config.clone(),
            rooms: Arc::new(DashMap::new()),
            sessions: Arc::new(DashMap::new()),
            rate_limits: Arc::new(DashMap::new()),
            seqs: Arc::new(RwLock::new(HashMap::new())),
        })
    }

    pub async fn migrate(&self) -> anyhow::Result<()> {
        sqlx::migrate!("./migrations").run(&self.db).await?;
        tracing::info!("migrations applied");
        Ok(())
    }

    pub fn room_sender(&self, room_id: &str) -> broadcast::Sender<String> {
        self.rooms
            .entry(room_id.to_string())
            .or_insert_with(|| {
                let (tx, _) = broadcast::channel(512);
                tx
            })
            .clone()
    }

    pub fn broadcast(&self, room_id: &str, msg: &ServerMessage) {
        if let Ok(json) = serde_json::to_string(msg) {
            let tx = self.room_sender(room_id);
            let _ = tx.send(json);
        }
    }

    pub fn send_to_conn(tx: &tokio::sync::mpsc::UnboundedSender<Message>, msg: &ServerMessage) {
        if let Ok(json) = serde_json::to_string(msg) {
            let _ = tx.send(Message::Text(json.into()));
        }
    }

    pub async fn next_seq(&self, room_id: &str, branch_id: &str) -> u64 {
        let key = (room_id.to_string(), branch_id.to_string());
        {
            let guard = self.seqs.read().await;
            if !guard.contains_key(&key) {
                drop(guard);
                let max: Option<i64> = sqlx::query_scalar(
                    r#"SELECT MAX(seq) FROM envelopes WHERE room_id = $1 AND branch_id = $2"#,
                )
                .bind(room_id)
                .bind(branch_id)
                .fetch_one(&self.db)
                .await
                .ok()
                .flatten();
                let mut w = self.seqs.write().await;
                w.entry(key.clone()).or_insert(max.unwrap_or(0) as u64);
            }
        }
        let mut guard = self.seqs.write().await;
        let entry = guard.entry(key).or_insert(0);
        *entry += 1;
        *entry
    }

    pub async fn ensure_seq_floor(&self, room_id: &str, branch_id: &str, floor: u64) {
        let mut guard = self.seqs.write().await;
        let key = (room_id.to_string(), branch_id.to_string());
        let entry = guard.entry(key).or_insert(0);
        if *entry < floor {
            *entry = floor;
        }
    }

    pub fn rate_limiter(&self, participant_id: &str) -> Arc<RateLimiter> {
        self.rate_limits
            .entry(participant_id.to_string())
            .or_insert_with(|| Arc::new(RateLimiter::new(self.config.rate_limit_per_second)))
            .clone()
    }
}
