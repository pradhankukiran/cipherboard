use std::sync::Arc;

use axum::extract::{DefaultBodyLimit, Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};
use crate::fingerprint::{fingerprint_from_spki_b64, fingerprints_match};
use crate::limits::{
    valid_b64, valid_display_name, valid_id, MAX_FINGERPRINT, MAX_PUBLIC_KEY_B64,
};
use crate::protocol::{BranchPublic, ParticipantPublic, ServerMessage};
use crate::state::{AppState, Session};
use crate::ws;

fn validate_key_fingerprint(spki: &str, claimed_fp: &str) -> AppResult<String> {
    if !valid_b64(spki, MAX_PUBLIC_KEY_B64) {
        return Err(AppError::BadRequest("invalid public_key_spki".into()));
    }
    if claimed_fp.is_empty() || claimed_fp.len() > MAX_FINGERPRINT {
        return Err(AppError::BadRequest("invalid fingerprint".into()));
    }
    let actual = fingerprint_from_spki_b64(spki)
        .map_err(|e| AppError::BadRequest(e))?;
    if !fingerprints_match(claimed_fp, &actual) {
        return Err(AppError::BadRequest(
            "fingerprint does not match public key".into(),
        ));
    }
    Ok(actual)
}

pub fn api_router() -> Router<Arc<AppState>> {
    let protected_lesson = Router::new()
        .route(
            "/api/demo/protected-lesson",
            post(seal_protected_lesson),
        )
        .layer(DefaultBodyLimit::max(
            crate::protected_lesson::SEAL_REQUEST_BODY_LIMIT,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/api/rooms", post(create_room))
        .route("/api/rooms/{room_id}/join", post(join_room))
        .route("/api/rooms/{room_id}", get(get_room))
        .merge(protected_lesson)
        .route("/ws", get(ws::ws_handler))
}

/// Seal a static demo lesson to a browser-provided RSA-OAEP public key.
/// Stateless; no room session required.
async fn seal_protected_lesson(
    Json(body): Json<crate::protected_lesson::SealLessonRequest>,
) -> AppResult<Json<crate::protected_lesson::SealLessonResponse>> {
    let sealed = crate::protected_lesson::seal_demo_lesson(&body.rsa_public_key_spki_b64)?;
    // Do not log secrets, plaintext, or key material.
    tracing::info!(lesson_id = %sealed.lesson_id, "protected lesson sealed");
    Ok(Json(sealed))
}

async fn health() -> Json<serde_json::Value> {
    Json(serde_json::json!({ "status": "ok", "service": "cipherboard" }))
}

#[derive(Debug, Deserialize)]
pub struct CreateRoomRequest {
    pub display_name: String,
    pub public_key_spki: String,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct CreateRoomResponse {
    pub room_id: String,
    pub invite_code: String,
    pub participant_id: String,
    pub session_token: String,
    pub branch_id: String,
}

async fn create_room(
    State(state): State<Arc<AppState>>,
    Json(body): Json<CreateRoomRequest>,
) -> AppResult<Json<CreateRoomResponse>> {
    if !valid_display_name(&body.display_name) {
        return Err(AppError::BadRequest("invalid display_name".into()));
    }
    let fingerprint = validate_key_fingerprint(&body.public_key_spki, &body.fingerprint)?;

    let room_id = new_id("rm");
    let participant_id = new_id("p");
    let branch_id = new_id("br");
    let invite_code = generate_invite_code();
    let invite_hash = hash_invite(&invite_code);
    let session_token = generate_token();

    let mut tx = state.db.begin().await?;

    sqlx::query(
        r#"
        INSERT INTO rooms (id, invite_code_hash, host_participant_id, locked)
        VALUES ($1, $2, $3, FALSE)
        "#,
    )
    .bind(&room_id)
    .bind(&invite_hash)
    .bind(&participant_id)
    .execute(&mut *tx)
    .await?;

    let token_hash = hash_token(&session_token);

    sqlx::query(
        r#"
        INSERT INTO participants
            (id, room_id, display_name, public_key_spki, fingerprint, role, status, session_token_hash)
        VALUES ($1, $2, $3, $4, $5, 'host', 'approved', $6)
        "#,
    )
    .bind(&participant_id)
    .bind(&room_id)
    .bind(body.display_name.trim())
    .bind(&body.public_key_spki)
    .bind(&fingerprint)
    .bind(&token_hash)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        r#"
        INSERT INTO branches (id, room_id, name, parent_branch_id, fork_seq, created_by)
        VALUES ($1, $2, 'main', NULL, NULL, $3)
        "#,
    )
    .bind(&branch_id)
    .bind(&room_id)
    .bind(&participant_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    state.sessions.insert(
        session_token.clone(),
        Session {
            participant_id: participant_id.clone(),
            room_id: room_id.clone(),
            role: "host".into(),
            status: "approved".into(),
        },
    );

    tracing::info!(%room_id, %participant_id, "room created");

    Ok(Json(CreateRoomResponse {
        room_id,
        invite_code,
        participant_id,
        session_token,
        branch_id,
    }))
}

#[derive(Debug, Deserialize)]
pub struct JoinRoomRequest {
    pub invite_code: String,
    pub display_name: String,
    pub public_key_spki: String,
    pub fingerprint: String,
}

#[derive(Debug, Serialize)]
pub struct JoinRoomResponse {
    pub room_id: String,
    pub participant_id: String,
    pub session_token: String,
    pub status: String,
    pub host_fingerprint: String,
    pub host_public_key_spki: String,
}

async fn join_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
    Json(body): Json<JoinRoomRequest>,
) -> AppResult<Json<JoinRoomResponse>> {
    if !valid_id(&room_id) {
        return Err(AppError::BadRequest("invalid room_id".into()));
    }
    if !valid_display_name(&body.display_name) {
        return Err(AppError::BadRequest("invalid display_name".into()));
    }
    let fingerprint = validate_key_fingerprint(&body.public_key_spki, &body.fingerprint)?;
    if body.invite_code.len() < 6 || body.invite_code.len() > 64 {
        return Err(AppError::BadRequest("invalid invite_code".into()));
    }

    let room = sqlx::query_as::<_, RoomRow>(
        r#"SELECT invite_code_hash, host_participant_id, locked FROM rooms WHERE id = $1"#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| AppError::NotFound("room not found".into()))?;

    let hash = hash_invite(&body.invite_code);
    if hash != room.invite_code_hash {
        return Err(AppError::Unauthorized("invalid invite code".into()));
    }
    if room.locked {
        return Err(AppError::Forbidden("room is locked".into()));
    }

    let approved_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM participants WHERE room_id = $1 AND status = 'approved'"#,
    )
    .bind(&room_id)
    .fetch_one(&state.db)
    .await?;

    if approved_count as usize >= state.config.max_room_size {
        return Err(AppError::Forbidden("room is full".into()));
    }

    let waiting_count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM participants WHERE room_id = $1 AND status = 'waiting'"#,
    )
    .bind(&room_id)
    .fetch_one(&state.db)
    .await?;
    if waiting_count > 32 {
        return Err(AppError::Forbidden("waiting room full".into()));
    }

    let host = sqlx::query_as::<_, ParticipantRow>(
        r#"
        SELECT id, room_id, display_name, public_key_spki, fingerprint, role, status
        FROM participants WHERE id = $1
        "#,
    )
    .bind(&room.host_participant_id)
    .fetch_one(&state.db)
    .await?;

    let participant_id = new_id("p");
    let session_token = generate_token();

    let token_hash = hash_token(&session_token);

    sqlx::query(
        r#"
        INSERT INTO participants
            (id, room_id, display_name, public_key_spki, fingerprint, role, status, session_token_hash)
        VALUES ($1, $2, $3, $4, $5, 'guest', 'waiting', $6)
        "#,
    )
    .bind(&participant_id)
    .bind(&room_id)
    .bind(body.display_name.trim())
    .bind(&body.public_key_spki)
    .bind(&fingerprint)
    .bind(&token_hash)
    .execute(&state.db)
    .await?;

    state.sessions.insert(
        session_token.clone(),
        Session {
            participant_id: participant_id.clone(),
            room_id: room_id.clone(),
            role: "guest".into(),
            status: "waiting".into(),
        },
    );

    let participant = ParticipantPublic {
        id: participant_id.clone(),
        display_name: body.display_name.trim().to_string(),
        public_key_spki: body.public_key_spki,
        fingerprint,
        role: "guest".into(),
        status: "waiting".into(),
    };

    state.broadcast(
        &room_id,
        &ServerMessage::ParticipantUpdated { participant },
    );

    tracing::info!(%room_id, %participant_id, "join requested");

    Ok(Json(JoinRoomResponse {
        room_id,
        participant_id,
        session_token,
        status: "waiting".into(),
        host_fingerprint: host.fingerprint,
        host_public_key_spki: host.public_key_spki,
    }))
}

#[derive(Debug, Serialize)]
pub struct RoomInfoResponse {
    pub room_id: String,
    pub locked: bool,
    pub participant_count: i64,
    pub max_room_size: usize,
}

async fn get_room(
    State(state): State<Arc<AppState>>,
    Path(room_id): Path<String>,
) -> AppResult<Json<RoomInfoResponse>> {
    if !valid_id(&room_id) {
        return Err(AppError::BadRequest("invalid room_id".into()));
    }
    let locked: Option<bool> =
        sqlx::query_scalar(r#"SELECT locked FROM rooms WHERE id = $1"#)
            .bind(&room_id)
            .fetch_optional(&state.db)
            .await?;
    let locked = locked.ok_or_else(|| AppError::NotFound("room not found".into()))?;
    let count: i64 = sqlx::query_scalar(
        r#"SELECT COUNT(*) FROM participants WHERE room_id = $1 AND status = 'approved'"#,
    )
    .bind(&room_id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(RoomInfoResponse {
        room_id,
        locked,
        participant_count: count,
        max_room_size: state.config.max_room_size,
    }))
}

#[derive(sqlx::FromRow)]
struct RoomRow {
    invite_code_hash: String,
    host_participant_id: String,
    locked: bool,
}

#[derive(sqlx::FromRow)]
pub struct ParticipantRow {
    pub id: String,
    pub room_id: String,
    pub display_name: String,
    pub public_key_spki: String,
    pub fingerprint: String,
    pub role: String,
    pub status: String,
}

impl From<ParticipantRow> for ParticipantPublic {
    fn from(r: ParticipantRow) -> Self {
        Self {
            id: r.id,
            display_name: r.display_name,
            public_key_spki: r.public_key_spki,
            fingerprint: r.fingerprint,
            role: r.role,
            status: r.status,
        }
    }
}

#[derive(sqlx::FromRow)]
pub struct BranchRow {
    pub id: String,
    pub name: String,
    pub parent_branch_id: Option<String>,
    pub fork_seq: Option<i64>,
}

impl From<BranchRow> for BranchPublic {
    fn from(r: BranchRow) -> Self {
        Self {
            id: r.id,
            name: r.name,
            parent_branch_id: r.parent_branch_id,
            fork_seq: r.fork_seq.map(|s| s as u64),
        }
    }
}

fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4().simple())
}

fn generate_invite_code() -> String {
    let mut bytes = [0u8; 9];
    rand::thread_rng().fill_bytes(&mut bytes);
    // Crockford-ish base32 without padding for easy sharing
    const ALPH: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(12);
    for b in bytes {
        out.push(ALPH[(b as usize) % ALPH.len()] as char);
    }
    out
}

fn hash_invite(code: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(code.trim().to_uppercase().as_bytes());
    hex::encode(hasher.finalize())
}

fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

fn hash_token(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    hex::encode(hasher.finalize())
}

/// Resolve a session from memory or database (survives process restart).
pub async fn resolve_session(state: &AppState, token: &str) -> Option<Session> {
    if let Some(s) = state.sessions.get(token) {
        return Some(s.clone());
    }
    let hash = hash_token(token);
    let row = sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT id, room_id, role, status
        FROM participants
        WHERE session_token_hash = $1
        "#,
    )
    .bind(&hash)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()?;
    let session = Session {
        participant_id: row.id,
        room_id: row.room_id,
        role: row.role,
        status: row.status,
    };
    state.sessions.insert(token.to_string(), session.clone());
    Some(session)
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    room_id: String,
    role: String,
    status: String,
}

pub async fn load_participants(
    state: &AppState,
    room_id: &str,
) -> AppResult<Vec<ParticipantPublic>> {
    let rows = sqlx::query_as::<_, ParticipantRow>(
        r#"
        SELECT id, room_id, display_name, public_key_spki, fingerprint, role, status
        FROM participants
        WHERE room_id = $1 AND status IN ('waiting', 'approved')
        ORDER BY created_at ASC
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}

pub async fn load_branches(state: &AppState, room_id: &str) -> AppResult<Vec<BranchPublic>> {
    let rows = sqlx::query_as::<_, BranchRow>(
        r#"
        SELECT id, name, parent_branch_id, fork_seq
        FROM branches WHERE room_id = $1 ORDER BY created_at ASC
        "#,
    )
    .bind(room_id)
    .fetch_all(&state.db)
    .await?;
    Ok(rows.into_iter().map(Into::into).collect())
}
