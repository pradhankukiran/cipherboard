use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub host: String,
    pub port: u16,
    pub static_dir: PathBuf,
    pub max_room_size: usize,
    pub rate_limit_per_second: u32,
    pub max_message_bytes: usize,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let database_url = env::var("DATABASE_URL")
            .map_err(|_| anyhow::anyhow!("DATABASE_URL is required"))?;
        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into());
        let port: u16 = env::var("PORT")
            .unwrap_or_else(|_| "8080".into())
            .parse()
            .map_err(|_| anyhow::anyhow!("PORT must be a number"))?;
        let static_dir = env::var("STATIC_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("static"));
        let max_room_size: usize = env::var("MAX_ROOM_SIZE")
            .unwrap_or_else(|_| "8".into())
            .parse()
            .unwrap_or(8)
            .clamp(2, 8);
        let rate_limit_per_second: u32 = env::var("RATE_LIMIT_PER_SECOND")
            .unwrap_or_else(|_| "30".into())
            .parse()
            .unwrap_or(30);
        let max_message_bytes: usize = env::var("MAX_MESSAGE_BYTES")
            .unwrap_or_else(|_| "131072".into())
            .parse()
            .unwrap_or(131072);

        Ok(Self {
            database_url,
            host,
            port,
            static_dir,
            max_room_size,
            rate_limit_per_second,
            max_message_bytes,
        })
    }
}
