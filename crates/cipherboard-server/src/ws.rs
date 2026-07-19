use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{Query, State, WebSocketUpgrade};
use axum::response::IntoResponse;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::limits::{
    valid_b64, valid_id, MAX_AAD_JSON, MAX_BRANCH_NAME, MAX_CIPHERTEXT_B64,
    MAX_ENVELOPES_PER_MESSAGE, MAX_EVENT_ID, MAX_IV_B64, PROTOCOL_VERSION,
};
use crate::protocol::{
    BranchPublic, ClientMessage, EnvelopeWire, ParticipantPublic, ServerMessage,
};
use crate::routes::{load_branches, load_participants, resolve_session, ParticipantRow};
use crate::state::AppState;

#[derive(Debug, Deserialize)]
pub struct WsQuery {
    pub token: String,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    Query(q): Query<WsQuery>,
) -> impl IntoResponse {
    if q.token.is_empty() || q.token.len() > 128 {
        return AppError::Unauthorized("invalid token".into()).into_response();
    }
    let Some(session) = resolve_session(&state, &q.token).await else {
        return AppError::Unauthorized("unknown session".into()).into_response();
    };
    ws.on_upgrade(move |socket| {
        handle_socket(
            socket,
            state,
            session.participant_id,
            session.room_id,
            q.token,
        )
    })
}

async fn handle_socket(
    socket: WebSocket,
    state: Arc<AppState>,
    participant_id: String,
    room_id: String,
    token: String,
) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    let mut room_rx = state.room_sender(&room_id).subscribe();

    // Outbound task: local queue + room broadcast
    let out_state = state.clone();
    let out_pid = participant_id.clone();
    let out_room = room_id.clone();
    let writer = tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = rx.recv() => {
                    match msg {
                        Some(m) => {
                            if sink.send(m).await.is_err() {
                                break;
                            }
                        }
                        None => break,
                    }
                }
                msg = room_rx.recv() => {
                    match msg {
                        Ok(json) => {
                            // Filter envelopes not for this participant
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&json) {
                                if parsed.get("type").and_then(|t| t.as_str()) == Some("envelope") {
                                    let recip = parsed.get("recipient_id").and_then(|v| v.as_str());
                                    if recip != Some(out_pid.as_str()) {
                                        continue;
                                    }
                                }
                                if parsed.get("type").and_then(|t| t.as_str()) == Some("history_package") {
                                    let recip = parsed.get("to_participant_id").and_then(|v| v.as_str());
                                    if recip != Some(out_pid.as_str()) {
                                        continue;
                                    }
                                }
                            }
                            if sink.send(Message::Text(json.into())).await.is_err() {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                            tracing::warn!(room = %out_room, "ws lagged");
                            continue;
                        }
                        Err(_) => break,
                    }
                }
            }
        }
        let _ = out_state;
    });

    // Load session status
    let session = match state.sessions.get(&token) {
        Some(s) => s.clone(),
        None => {
            AppState::send_to_conn(
                &tx,
                &ServerMessage::Error {
                    code: "unauthorized".into(),
                    message: "session expired".into(),
                },
            );
            return;
        }
    };

    let main_branch = sqlx::query_scalar::<_, String>(
        r#"SELECT id FROM branches WHERE room_id = $1 ORDER BY created_at ASC LIMIT 1"#,
    )
    .bind(&room_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten()
    .unwrap_or_default();

    AppState::send_to_conn(
        &tx,
        &ServerMessage::Welcome {
            participant_id: participant_id.clone(),
            room_id: room_id.clone(),
            role: session.role.clone(),
            status: session.status.clone(),
            branch_id: main_branch.clone(),
        },
    );

    if let (Ok(participants), Ok(branches)) = (
        load_participants(&state, &room_id).await,
        load_branches(&state, &room_id).await,
    ) {
        let locked: bool = sqlx::query_scalar(r#"SELECT locked FROM rooms WHERE id = $1"#)
            .bind(&room_id)
            .fetch_one(&state.db)
            .await
            .unwrap_or(false);
        AppState::send_to_conn(
            &tx,
            &ServerMessage::RoomState {
                locked,
                participants,
                branches,
            },
        );
    }

    // Catch-up envelopes for approved participants
    if session.status == "approved" {
        if let Ok(rows) = sqlx::query_as::<_, EnvelopeRow>(
            r#"
            SELECT room_id, branch_id, event_id, sender_id, recipient_id, seq,
                   protocol_version, iv_b64, ciphertext_b64, aad_json
            FROM envelopes
            WHERE room_id = $1 AND recipient_id = $2
            ORDER BY seq ASC
            LIMIT 5000
            "#,
        )
        .bind(&room_id)
        .bind(&participant_id)
        .fetch_all(&state.db)
        .await
        {
            for row in rows {
                state
                    .ensure_seq_floor(&room_id, &row.branch_id, row.seq as u64)
                    .await;
                AppState::send_to_conn(
                    &tx,
                    &ServerMessage::Envelope {
                        room_id: row.room_id,
                        branch_id: row.branch_id,
                        event_id: row.event_id,
                        sender_id: row.sender_id,
                        recipient_id: row.recipient_id,
                        seq: row.seq as u64,
                        protocol_version: row.protocol_version,
                        iv_b64: row.iv_b64,
                        ciphertext_b64: row.ciphertext_b64,
                        aad_json: row.aad_json,
                    },
                );
            }
        }

        if let Ok(pkgs) = sqlx::query_as::<_, HistoryRow>(
            r#"
            SELECT id, branch_id, from_participant_id, to_participant_id, through_seq,
                   iv_b64, ciphertext_b64, aad_json
            FROM history_packages
            WHERE room_id = $1 AND to_participant_id = $2
            ORDER BY created_at ASC
            "#,
        )
        .bind(&room_id)
        .bind(&participant_id)
        .fetch_all(&state.db)
        .await
        {
            for p in pkgs {
                AppState::send_to_conn(
                    &tx,
                    &ServerMessage::HistoryPackage {
                        id: p.id,
                        branch_id: p.branch_id,
                        from_participant_id: p.from_participant_id,
                        to_participant_id: p.to_participant_id,
                        through_seq: p.through_seq as u64,
                        iv_b64: p.iv_b64,
                        ciphertext_b64: p.ciphertext_b64,
                        aad_json: p.aad_json,
                    },
                );
            }
        }
    }

    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => {
                if b.len() > state.config.max_message_bytes {
                    AppState::send_to_conn(
                        &tx,
                        &ServerMessage::Error {
                            code: "payload_too_large".into(),
                            message: "message too large".into(),
                        },
                    );
                    continue;
                }
                match String::from_utf8(b.to_vec()) {
                    Ok(s) => s,
                    Err(_) => continue,
                }
            }
            Message::Ping(p) => {
                let _ = tx.send(Message::Pong(p));
                continue;
            }
            Message::Close(_) => break,
            _ => continue,
        };

        if text.len() > state.config.max_message_bytes {
            AppState::send_to_conn(
                &tx,
                &ServerMessage::Error {
                    code: "payload_too_large".into(),
                    message: "message too large".into(),
                },
            );
            continue;
        }

        let limiter = state.rate_limiter(&participant_id);
        if !limiter.check() {
            AppState::send_to_conn(
                &tx,
                &ServerMessage::Error {
                    code: "rate_limited".into(),
                    message: "slow down".into(),
                },
            );
            continue;
        }

        let parsed: ClientMessage = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(_) => {
                AppState::send_to_conn(
                    &tx,
                    &ServerMessage::Error {
                        code: "bad_message".into(),
                        message: "invalid message".into(),
                    },
                );
                continue;
            }
        };

        if let Err(e) = handle_client_message(
            &state,
            &tx,
            &token,
            &participant_id,
            &room_id,
            parsed,
        )
        .await
        {
            AppState::send_to_conn(
                &tx,
                &ServerMessage::Error {
                    code: "error".into(),
                    message: e,
                },
            );
        }
    }

    writer.abort();
    tracing::info!(%participant_id, %room_id, "ws disconnected");
}

async fn handle_client_message(
    state: &AppState,
    tx: &mpsc::UnboundedSender<Message>,
    token: &str,
    participant_id: &str,
    room_id: &str,
    msg: ClientMessage,
) -> Result<(), String> {
    let session = state
        .sessions
        .get(token)
        .map(|s| s.clone())
        .ok_or_else(|| "session expired".to_string())?;

    match msg {
        ClientMessage::Ping { ts } => {
            AppState::send_to_conn(tx, &ServerMessage::Pong { ts });
            Ok(())
        }
        ClientMessage::Hello { .. } | ClientMessage::RequestJoin {} => Ok(()),
        ClientMessage::Approve { target_id } => {
            require_host(&session)?;
            set_status(state, room_id, &target_id, "approved").await?;
            // Update session if present
            update_session_status(state, &target_id, "approved");
            broadcast_participant(state, room_id, &target_id).await?;
            Ok(())
        }
        ClientMessage::Reject { target_id } => {
            require_host(&session)?;
            set_status(state, room_id, &target_id, "rejected").await?;
            update_session_status(state, &target_id, "rejected");
            broadcast_participant(state, room_id, &target_id).await?;
            Ok(())
        }
        ClientMessage::Remove { target_id } => {
            require_host(&session)?;
            if target_id == participant_id {
                return Err("cannot remove self".into());
            }
            set_status(state, room_id, &target_id, "removed").await?;
            update_session_status(state, &target_id, "removed");
            broadcast_participant(state, room_id, &target_id).await?;
            // Clients rotate keys on remove; server just stops future delivery
            Ok(())
        }
        ClientMessage::Lock { locked } => {
            require_host(&session)?;
            sqlx::query(r#"UPDATE rooms SET locked = $1, updated_at = NOW() WHERE id = $2"#)
                .bind(locked)
                .bind(room_id)
                .execute(&state.db)
                .await
                .map_err(|e| e.to_string())?;
            let participants = load_participants(state, room_id)
                .await
                .map_err(|e| e.to_string())?;
            let branches = load_branches(state, room_id)
                .await
                .map_err(|e| e.to_string())?;
            state.broadcast(
                room_id,
                &ServerMessage::RoomState {
                    locked,
                    participants,
                    branches,
                },
            );
            Ok(())
        }
        ClientMessage::RelayEnvelopes {
            branch_id,
            event_id,
            seq_hint: _,
            envelopes,
        } => {
            require_approved(&session)?;
            if !valid_id(&branch_id) {
                return Err("invalid branch_id".into());
            }
            if event_id.is_empty() || event_id.len() > MAX_EVENT_ID {
                return Err("invalid event_id".into());
            }
            if envelopes.is_empty() || envelopes.len() > MAX_ENVELOPES_PER_MESSAGE {
                return Err("invalid envelopes count".into());
            }
            for env in &envelopes {
                validate_envelope(env)?;
            }

            // Verify branch belongs to room
            let branch_ok: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM branches WHERE id = $1 AND room_id = $2"#,
            )
            .bind(&branch_id)
            .bind(room_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            if branch_ok.is_none() {
                return Err("unknown branch".into());
            }

            // Only deliver to currently approved recipients (plus self)
            let approved: Vec<String> = sqlx::query_scalar(
                r#"SELECT id FROM participants WHERE room_id = $1 AND status = 'approved'"#,
            )
            .bind(room_id)
            .fetch_all(&state.db)
            .await
            .map_err(|e| e.to_string())?;

            let seq = state.next_seq(room_id, &branch_id).await;

            for env in envelopes {
                if !approved.iter().any(|id| id == &env.recipient_id)
                    && env.recipient_id != participant_id
                {
                    continue;
                }
                // Persist
                let res = sqlx::query(
                    r#"
                    INSERT INTO envelopes
                        (room_id, branch_id, event_id, sender_id, recipient_id, seq,
                         protocol_version, iv_b64, ciphertext_b64, aad_json)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                    ON CONFLICT (room_id, branch_id, event_id, recipient_id) DO NOTHING
                    "#,
                )
                .bind(room_id)
                .bind(&branch_id)
                .bind(&event_id)
                .bind(participant_id)
                .bind(&env.recipient_id)
                .bind(seq as i64)
                .bind(env.protocol_version)
                .bind(&env.iv_b64)
                .bind(&env.ciphertext_b64)
                .bind(&env.aad_json)
                .execute(&state.db)
                .await
                .map_err(|e| e.to_string())?;

                if res.rows_affected() == 0 {
                    // duplicate
                    continue;
                }

                state.broadcast(
                    room_id,
                    &ServerMessage::Envelope {
                        room_id: room_id.to_string(),
                        branch_id: branch_id.clone(),
                        event_id: event_id.clone(),
                        sender_id: participant_id.to_string(),
                        recipient_id: env.recipient_id,
                        seq,
                        protocol_version: env.protocol_version,
                        iv_b64: env.iv_b64,
                        ciphertext_b64: env.ciphertext_b64,
                        aad_json: env.aad_json,
                    },
                );
            }
            Ok(())
        }
        ClientMessage::HistoryPackage {
            branch_id,
            to_participant_id,
            through_seq,
            iv_b64,
            ciphertext_b64,
            aad_json,
        } => {
            require_approved(&session)?;
            if !valid_id(&branch_id) || !valid_id(&to_participant_id) {
                return Err("invalid ids".into());
            }
            if !valid_b64(&iv_b64, MAX_IV_B64)
                || !valid_b64(&ciphertext_b64, MAX_CIPHERTEXT_B64)
                || aad_json.is_empty()
                || aad_json.len() > MAX_AAD_JSON
            {
                return Err("invalid history package".into());
            }

            let target_status: Option<String> = sqlx::query_scalar(
                r#"SELECT status FROM participants WHERE id = $1 AND room_id = $2"#,
            )
            .bind(&to_participant_id)
            .bind(room_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            if target_status.as_deref() != Some("approved") {
                return Err("target not approved".into());
            }

            let id = format!("hp_{}", uuid::Uuid::new_v4().simple());
            sqlx::query(
                r#"
                INSERT INTO history_packages
                    (id, room_id, branch_id, from_participant_id, to_participant_id,
                     through_seq, iv_b64, ciphertext_b64, aad_json)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                "#,
            )
            .bind(&id)
            .bind(room_id)
            .bind(&branch_id)
            .bind(participant_id)
            .bind(&to_participant_id)
            .bind(through_seq as i64)
            .bind(&iv_b64)
            .bind(&ciphertext_b64)
            .bind(&aad_json)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;

            state.broadcast(
                room_id,
                &ServerMessage::HistoryPackage {
                    id,
                    branch_id,
                    from_participant_id: participant_id.to_string(),
                    to_participant_id,
                    through_seq,
                    iv_b64,
                    ciphertext_b64,
                    aad_json,
                },
            );
            Ok(())
        }
        ClientMessage::CreateBranch {
            name,
            parent_branch_id,
            fork_seq,
        } => {
            require_approved(&session)?;
            let name = name.trim().to_string();
            if name.is_empty() || name.len() > MAX_BRANCH_NAME {
                return Err("invalid branch name".into());
            }
            if !valid_id(&parent_branch_id) {
                return Err("invalid parent".into());
            }
            let parent_ok: Option<bool> = sqlx::query_scalar(
                r#"SELECT TRUE FROM branches WHERE id = $1 AND room_id = $2"#,
            )
            .bind(&parent_branch_id)
            .bind(room_id)
            .fetch_optional(&state.db)
            .await
            .map_err(|e| e.to_string())?;
            if parent_ok.is_none() {
                return Err("unknown parent branch".into());
            }

            let id = format!("br_{}", uuid::Uuid::new_v4().simple());
            sqlx::query(
                r#"
                INSERT INTO branches (id, room_id, name, parent_branch_id, fork_seq, created_by)
                VALUES ($1,$2,$3,$4,$5,$6)
                "#,
            )
            .bind(&id)
            .bind(room_id)
            .bind(&name)
            .bind(&parent_branch_id)
            .bind(fork_seq as i64)
            .bind(participant_id)
            .execute(&state.db)
            .await
            .map_err(|e| e.to_string())?;

            let branch = BranchPublic {
                id,
                name,
                parent_branch_id: Some(parent_branch_id),
                fork_seq: Some(fork_seq),
            };
            state.broadcast(room_id, &ServerMessage::BranchCreated { branch });
            Ok(())
        }
    }
}

fn require_host(session: &crate::state::Session) -> Result<(), String> {
    if session.role != "host" || session.status != "approved" {
        return Err("host only".into());
    }
    Ok(())
}

fn require_approved(session: &crate::state::Session) -> Result<(), String> {
    if session.status != "approved" {
        return Err("not approved".into());
    }
    Ok(())
}

fn validate_envelope(env: &EnvelopeWire) -> Result<(), String> {
    if !valid_id(&env.recipient_id) {
        return Err("invalid recipient".into());
    }
    if env.protocol_version != PROTOCOL_VERSION {
        return Err("unsupported protocol version".into());
    }
    if !valid_b64(&env.iv_b64, MAX_IV_B64) {
        return Err("invalid iv".into());
    }
    if !valid_b64(&env.ciphertext_b64, MAX_CIPHERTEXT_B64) {
        return Err("invalid ciphertext".into());
    }
    if env.aad_json.is_empty() || env.aad_json.len() > MAX_AAD_JSON {
        return Err("invalid aad".into());
    }
    Ok(())
}

async fn set_status(
    state: &AppState,
    room_id: &str,
    target_id: &str,
    status: &str,
) -> Result<(), String> {
    if !valid_id(target_id) {
        return Err("invalid target".into());
    }
    let res = sqlx::query(
        r#"
        UPDATE participants SET status = $1, updated_at = NOW()
        WHERE id = $2 AND room_id = $3 AND role = 'guest'
        "#,
    )
    .bind(status)
    .bind(target_id)
    .bind(room_id)
    .execute(&state.db)
    .await
    .map_err(|e| e.to_string())?;
    if res.rows_affected() == 0 {
        return Err("target not found".into());
    }

    if status == "approved" {
        let count: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM participants WHERE room_id = $1 AND status = 'approved'"#,
        )
        .bind(room_id)
        .fetch_one(&state.db)
        .await
        .map_err(|e| e.to_string())?;
        if count as usize > state.config.max_room_size {
            // roll back
            let _ = sqlx::query(
                r#"UPDATE participants SET status = 'waiting' WHERE id = $1 AND room_id = $2"#,
            )
            .bind(target_id)
            .bind(room_id)
            .execute(&state.db)
            .await;
            return Err("room full".into());
        }
    }
    Ok(())
}

fn update_session_status(state: &AppState, participant_id: &str, status: &str) {
    for mut entry in state.sessions.iter_mut() {
        if entry.participant_id == participant_id {
            entry.status = status.to_string();
        }
    }
    // DB status already updated by set_status; memory sessions stay in sync above.
}

async fn broadcast_participant(
    state: &AppState,
    room_id: &str,
    participant_id: &str,
) -> Result<(), String> {
    let row = sqlx::query_as::<_, ParticipantRow>(
        r#"
        SELECT id, room_id, display_name, public_key_spki, fingerprint, role, status
        FROM participants WHERE id = $1 AND room_id = $2
        "#,
    )
    .bind(participant_id)
    .bind(room_id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| e.to_string())?
    .ok_or_else(|| "not found".to_string())?;

    let participant: ParticipantPublic = row.into();
    state.broadcast(
        room_id,
        &ServerMessage::ParticipantUpdated { participant },
    );
    Ok(())
}

#[derive(sqlx::FromRow)]
struct EnvelopeRow {
    room_id: String,
    branch_id: String,
    event_id: String,
    sender_id: String,
    recipient_id: String,
    seq: i64,
    protocol_version: i32,
    iv_b64: String,
    ciphertext_b64: String,
    aad_json: String,
}

#[derive(sqlx::FromRow)]
struct HistoryRow {
    id: String,
    branch_id: String,
    from_participant_id: String,
    to_participant_id: String,
    through_seq: i64,
    iv_b64: String,
    ciphertext_b64: String,
    aad_json: String,
}

