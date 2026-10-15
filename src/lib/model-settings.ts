import { AuthError } from "./auth";
import { query } from "./db";
import { resolveAIModel } from "./ai-models";

type Session = { customerId: string; sessionTokenHash: string };

export async function getSessionModel(session: Session) {
  const result = await query<{ ai_model: string | null }>(`SELECT ai_model FROM user_sessions
    WHERE customer_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now()`, [session.customerId, session.sessionTokenHash]);
  if (!result.rows[0]) throw new AuthError("SESSION_EXPIRED");
  return result.rows[0].ai_model ?? process.env.AI_MODEL ?? null;
}

export async function setSessionModel(session: Session, requestedModel: string) {
  const model = await resolveAIModel(requestedModel);
  const result = await query(`UPDATE user_sessions SET ai_model=$3
    WHERE customer_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>now() RETURNING id`, [session.customerId, session.sessionTokenHash, model]);
  if (!result.rowCount) throw new AuthError("SESSION_EXPIRED");
  return { model };
}
