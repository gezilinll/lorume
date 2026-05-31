import pg from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;

/** Organization member role supported by the first Lorume auth layer. */
export type AuthMemberRole = "owner" | "admin" | "member";

/** Public invitation roles that can be granted through an email invite. */
export type AuthInvitableMemberRole = "admin" | "member";

/** Device token lifecycle states exposed to administrators. */
export type AuthDeviceTokenStatus = "pending" | "occupied" | "revoked" | "expired";

/** Invitation preview state used by the invite login flow. */
export type AuthInvitationPreviewStatus = "accepted" | "available" | "expired" | "not_found" | "revoked";

/** Organization audit event type for security-sensitive auth/access actions. */
export type AuthAuditEventType =
  | "auth.login_failed"
  | "auth.login_succeeded"
  | "auth.logout"
  | "device_token.created"
  | "device_token.occupied"
  | "device_token.reuse_rejected"
  | "device_token.revoked"
  | "invitation.accepted"
  | "invitation.rejected"
  | "invitation.sent";

/** Persisted email-code login challenge. */
export interface AuthLoginCode {
  attempts: number;
  codeHash: string;
  consumedAt?: Date | null;
  createdAt: Date;
  email: string;
  expiresAt: Date;
  id: string;
}

/** Lorume user identity. */
export interface AuthUser {
  createdAt: Date;
  displayName?: string | null;
  email: string;
  id: string;
  updatedAt: Date;
}

/** Organization summary visible to a signed-in user. */
export interface AuthOrganizationMembership {
  id: string;
  name: string;
  organizationId: string;
  role: AuthMemberRole;
  slug: string;
}

/** Current session context returned by `/api/me`. */
export interface AuthSessionContext {
  id: string;
  organizations: AuthOrganizationMembership[];
  user: AuthUser;
}

/** Created organization row. */
export interface AuthOrganization {
  createdByUserId: string;
  id: string;
  name: string;
  slug: string;
}

/** Device token verification result. */
export interface AuthDeviceTokenVerification {
  deviceId?: string | null;
  id: string;
  organizationId: string;
  status?: AuthDeviceTokenStatus;
  tokenPrefix: string;
}

/** Device token summary returned to organization admins. */
export interface AuthDeviceTokenSummary extends AuthDeviceTokenVerification {
  createdAt?: Date;
  expiresAt?: Date | null;
  lastUsedAt?: Date | null;
  name: string;
  occupiedAt?: Date | null;
  revokedAt?: Date | null;
  status: AuthDeviceTokenStatus;
}

/** Safe invitation preview used before the invited user signs in. */
export interface AuthInvitationPreview {
  email?: string;
  maskedEmail?: string;
  organizationId?: string;
  organizationName?: string;
  role?: AuthMemberRole;
  status: AuthInvitationPreviewStatus;
}

/** Append-only security event visible to organization admins. */
export interface AuthAuditEvent {
  actorUserId?: string | null;
  createdAt: Date;
  eventType: AuthAuditEventType;
  id: string;
  metadata: Record<string, unknown>;
  organizationId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
}

/** Repository contract used by auth HTTP handlers. */
export interface AuthStore {
  createLoginCode: (input: { codeHash: string; email: string; expiresAt: Date }) => Promise<AuthLoginCode>;
  consumeLoginCode: (input: { codeHash: string; email: string; now: Date }) => Promise<AuthLoginCode | null>;
  upsertUserForEmail: (email: string) => Promise<AuthUser>;
  createSession: (input: { expiresAt: Date; sessionHash: string; userId: string }) => Promise<{ id: string }>;
  readSessionByHash: (sessionHash: string, now: Date) => Promise<AuthSessionContext | null>;
  revokeSession: (sessionHash: string) => Promise<void>;
  createOrganization: (input: { createdByUserId: string; name: string; slug: string }) => Promise<AuthOrganization>;
  listOrganizationsForUser: (userId: string) => Promise<AuthOrganizationMembership[]>;
  /** Returns active organization owners and admins for infrastructure notifications and admin-only actions. */
  listOrganizationAdminUserIds: (organizationId: string) => Promise<string[]>;
  createInvitation: (input: {
    email: string;
    expiresAt: Date;
    invitedByUserId: string;
    organizationId: string;
    role: AuthInvitableMemberRole;
    tokenHash: string;
  }) => Promise<{ email: string; id: string; organizationId: string; role: AuthMemberRole }>;
  readInvitationPreview: (input: {
    now: Date;
    tokenHash: string;
  }) => Promise<AuthInvitationPreview>;
  acceptInvitation: (input: {
    email: string;
    now: Date;
    tokenHash: string;
    userId: string;
  }) => Promise<AuthOrganizationMembership | null>;
  revokeInvitation: (input: { id: string; now: Date }) => Promise<void>;
  createDeviceToken: (input: {
    deviceId?: string | null;
    expiresAt?: Date | null;
    name: string;
    organizationId: string;
    tokenHash: string;
    tokenPrefix: string;
  }) => Promise<AuthDeviceTokenSummary>;
  listDeviceTokens: (input: { now?: Date; organizationId: string }) => Promise<AuthDeviceTokenSummary[]>;
  revokeDeviceToken: (input: {
    actorUserId?: string | null;
    id: string;
    now: Date;
    organizationId: string;
    reason?: string;
  }) => Promise<AuthDeviceTokenSummary | null>;
  verifyDeviceToken: (tokenHash: string, now: Date, deviceId?: string | null) => Promise<AuthDeviceTokenVerification | null>;
  createAuditEvent: (input: {
    actorUserId?: string | null;
    eventType: AuthAuditEventType;
    metadata?: Record<string, unknown>;
    organizationId?: string | null;
    targetId?: string | null;
    targetType?: string | null;
  }) => Promise<AuthAuditEvent>;
  listAuditEvents: (input: {
    eventType?: AuthAuditEventType;
    limit?: number;
    organizationId: string;
  }) => Promise<AuthAuditEvent[]>;
  close: () => Promise<void>;
}

/** Postgres auth store options. */
export interface PostgresAuthStoreOptions {
  connectionString?: string;
}

/** Create the Postgres-backed auth repository. */
export function createPostgresAuthStore(options: PostgresAuthStoreOptions = {}): AuthStore {
  const pool = new Pool({
    connectionString: options.connectionString ?? process.env.DATABASE_URL ?? "postgres://lorume:lorume@127.0.0.1:54329/lorume",
  });

  return {
    async createLoginCode(input) {
      const result = await pool.query<AuthLoginCode>(`
        INSERT INTO email_login_codes (id, email, code_hash, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING
          id,
          email,
          code_hash AS "codeHash",
          consumed_at AS "consumedAt",
          attempts,
          created_at AS "createdAt",
          expires_at AS "expiresAt"
      `, [createId("code"), normalizeEmail(input.email), input.codeHash, input.expiresAt]);
      return result.rows[0];
    },
    async consumeLoginCode(input) {
      const result = await pool.query<AuthLoginCode>(`
        UPDATE email_login_codes
        SET consumed_at = $4
        WHERE id = (
          SELECT id
          FROM email_login_codes
          WHERE email = $1
            AND code_hash = $2
            AND consumed_at IS NULL
            AND expires_at > $3
          ORDER BY created_at DESC
          LIMIT 1
          FOR UPDATE
        )
        RETURNING
          id,
          email,
          code_hash AS "codeHash",
          consumed_at AS "consumedAt",
          attempts,
          created_at AS "createdAt",
          expires_at AS "expiresAt"
      `, [normalizeEmail(input.email), input.codeHash, input.now, input.now]);
      return result.rows[0] ?? null;
    },
    async upsertUserForEmail(email) {
      const normalizedEmail = normalizeEmail(email);
      const result = await pool.query<AuthUser>(`
        INSERT INTO users (id, email)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET updated_at = now()
        RETURNING
          id,
          email,
          display_name AS "displayName",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `, [createId("usr"), normalizedEmail]);
      return result.rows[0];
    },
    async createSession(input) {
      const result = await pool.query<{ id: string }>(`
        INSERT INTO sessions (id, user_id, session_hash, expires_at)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `, [createId("ses"), input.userId, input.sessionHash, input.expiresAt]);
      return result.rows[0];
    },
    async readSessionByHash(sessionHash, now) {
      const result = await pool.query<{
        displayName: string | null;
        email: string;
        id: string;
        sessionId: string;
        userCreatedAt: Date;
        userUpdatedAt: Date;
      }>(`
        SELECT
          s.id AS "sessionId",
          u.id,
          u.email,
          u.display_name AS "displayName",
          u.created_at AS "userCreatedAt",
          u.updated_at AS "userUpdatedAt"
        FROM sessions s
        INNER JOIN users u ON u.id = s.user_id
        WHERE s.session_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > $2
        LIMIT 1
      `, [sessionHash, now]);
      const row = result.rows[0];
      if (!row) return null;
      await pool.query("UPDATE sessions SET last_seen_at = $2 WHERE id = $1", [row.sessionId, now]);
      const user = {
        createdAt: row.userCreatedAt,
        displayName: row.displayName,
        email: row.email,
        id: row.id,
        updatedAt: row.userUpdatedAt,
      };
      return {
        id: row.sessionId,
        organizations: await listOrganizationsForUser(pool, user.id),
        user,
      };
    },
    async revokeSession(sessionHash) {
      await pool.query("UPDATE sessions SET revoked_at = now() WHERE session_hash = $1", [sessionHash]);
    },
    async createOrganization(input) {
      return withTransaction(pool, async (client) => {
        const organizationResult = await client.query<AuthOrganization>(`
          INSERT INTO organizations (id, name, slug, created_by_user_id)
          VALUES ($1, $2, $3, $4)
          RETURNING id, name, slug, created_by_user_id AS "createdByUserId"
        `, [createId("org"), input.name.trim(), input.slug.trim(), input.createdByUserId]);
        const organization = organizationResult.rows[0];
        await client.query(`
          INSERT INTO organization_members (id, organization_id, user_id, role, status)
          VALUES ($1, $2, $3, 'owner', 'active')
          ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'owner', status = 'active'
        `, [createId("mem"), organization.id, input.createdByUserId]);
        return organization;
      });
    },
    listOrganizationsForUser(userId) {
      return listOrganizationsForUser(pool, userId);
    },
    async listOrganizationAdminUserIds(organizationId) {
      const result = await pool.query<{ userId: string }>(`
        SELECT user_id AS "userId"
        FROM organization_members
        WHERE organization_id = $1
          AND status = 'active'
          AND role IN ('owner', 'admin')
        ORDER BY updated_at ASC, id ASC
      `, [organizationId]);
      return result.rows.map((row) => row.userId);
    },
    async createInvitation(input) {
      const result = await pool.query<{
        email: string;
        id: string;
        organizationId: string;
        role: AuthMemberRole;
      }>(`
        INSERT INTO organization_invitations (
          id, organization_id, email, role, token_hash, invited_by_user_id, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, organization_id AS "organizationId", email, role
      `, [
        createId("inv"),
        input.organizationId,
        normalizeEmail(input.email),
        input.role,
        input.tokenHash,
        input.invitedByUserId,
        input.expiresAt,
      ]);
      return result.rows[0];
    },
    async readInvitationPreview(input) {
      const result = await pool.query<{
        acceptedAt: Date | null;
        email: string;
        expiresAt: Date;
        organizationId: string;
        organizationName: string;
        revokedAt: Date | null;
        role: AuthMemberRole;
      }>(`
        SELECT
          i.organization_id AS "organizationId",
          i.email,
          i.role,
          i.expires_at AS "expiresAt",
          i.accepted_at AS "acceptedAt",
          i.revoked_at AS "revokedAt",
          o.name AS "organizationName"
        FROM organization_invitations i
        INNER JOIN organizations o ON o.id = i.organization_id
        WHERE i.token_hash = $1
        LIMIT 1
      `, [input.tokenHash]);
      const row = result.rows[0];
      if (!row) return { status: "not_found" };
      return {
        email: row.email,
        maskedEmail: maskEmail(row.email),
        organizationId: row.organizationId,
        organizationName: row.organizationName,
        role: row.role,
        status: row.revokedAt ? "revoked" : row.acceptedAt ? "accepted" : row.expiresAt <= input.now ? "expired" : "available",
      };
    },
    async acceptInvitation(input) {
      return withTransaction(pool, async (client) => {
        const invitationResult = await client.query<{
          email: string;
          organizationId: string;
          role: AuthMemberRole;
        }>(`
          UPDATE organization_invitations
          SET accepted_at = $3
          WHERE id = (
            SELECT id
            FROM organization_invitations
            WHERE token_hash = $1
              AND email = $2
              AND accepted_at IS NULL
              AND revoked_at IS NULL
              AND expires_at > $3
            LIMIT 1
            FOR UPDATE
          )
          RETURNING organization_id AS "organizationId", email, role
        `, [input.tokenHash, normalizeEmail(input.email), input.now]);
        const invitation = invitationResult.rows[0];
        if (!invitation) return null;
        await client.query(`
          INSERT INTO organization_members (id, organization_id, user_id, role, status)
          VALUES ($1, $2, $3, $4, 'active')
          ON CONFLICT (organization_id, user_id) DO UPDATE SET role = excluded.role, status = 'active'
        `, [createId("mem"), invitation.organizationId, input.userId, invitation.role]);
        const memberships = await listOrganizationsForUser(client, input.userId);
        return memberships.find((membership) => membership.organizationId === invitation.organizationId) ?? null;
      });
    },
    async revokeInvitation(input) {
      await pool.query("UPDATE organization_invitations SET revoked_at = $2 WHERE id = $1", [input.id, input.now]);
    },
    async createDeviceToken(input) {
      const result = await pool.query<DeviceTokenRow>(`
        INSERT INTO device_tokens (
          id, organization_id, device_id, name, token_hash, token_prefix, status, expires_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
        RETURNING
          id,
          organization_id AS "organizationId",
          device_id AS "deviceId",
          name,
          token_prefix AS "tokenPrefix",
          status,
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          occupied_at AS "occupiedAt",
          revoked_at AS "revokedAt",
          last_used_at AS "lastUsedAt"
      `, [
        createId("devtok"),
        input.organizationId,
        input.deviceId ?? null,
        input.name,
        input.tokenHash,
        input.tokenPrefix,
        input.expiresAt ?? null,
      ]);
      return toDeviceTokenSummary(result.rows[0]);
    },
    async listDeviceTokens(input) {
      const result = await pool.query<DeviceTokenRow>(`
        SELECT
          id,
          organization_id AS "organizationId",
          device_id AS "deviceId",
          name,
          token_prefix AS "tokenPrefix",
          status,
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          occupied_at AS "occupiedAt",
          revoked_at AS "revokedAt",
          last_used_at AS "lastUsedAt"
        FROM device_tokens
        WHERE organization_id = $1
        ORDER BY created_at DESC, id DESC
      `, [input.organizationId]);
      const now = input.now ?? new Date();
      return result.rows.map((row) => toDeviceTokenSummary(row, now));
    },
    async revokeDeviceToken(input) {
      const result = await pool.query<DeviceTokenRow>(`
        UPDATE device_tokens
        SET status = 'revoked', revoked_at = $3
        WHERE id = $1
          AND organization_id = $2
        RETURNING
          id,
          organization_id AS "organizationId",
          device_id AS "deviceId",
          name,
          token_prefix AS "tokenPrefix",
          status,
          created_at AS "createdAt",
          expires_at AS "expiresAt",
          occupied_at AS "occupiedAt",
          revoked_at AS "revokedAt",
          last_used_at AS "lastUsedAt"
      `, [input.id, input.organizationId, input.now]);
      const row = result.rows[0];
      if (!row) return null;
      await createAuditEvent(pool, {
        actorUserId: input.actorUserId,
        eventType: "device_token.revoked",
        metadata: {
          reason: input.reason ?? "manual",
          tokenPrefix: row.tokenPrefix,
        },
        organizationId: input.organizationId,
        targetId: row.id,
        targetType: "device_token",
      });
      return toDeviceTokenSummary(row, input.now);
    },
    async verifyDeviceToken(tokenHash, now, observedDeviceId) {
      return withTransaction(pool, async (client) => {
        const result = await client.query<DeviceTokenRow>(`
          SELECT
            id,
            organization_id AS "organizationId",
            device_id AS "deviceId",
            name,
            token_prefix AS "tokenPrefix",
            status,
            created_at AS "createdAt",
            expires_at AS "expiresAt",
            occupied_at AS "occupiedAt",
            revoked_at AS "revokedAt",
            last_used_at AS "lastUsedAt"
          FROM device_tokens
          WHERE token_hash = $1
          LIMIT 1
          FOR UPDATE
        `, [tokenHash]);
        const row = result.rows[0];
        if (!row) return null;
        const currentStatus = toDeviceTokenSummary(row, now).status;
        if (currentStatus === "expired") {
          await client.query("UPDATE device_tokens SET status = 'expired' WHERE id = $1", [row.id]);
          return null;
        }
        if (currentStatus === "revoked") return null;
        const deviceId = observedDeviceId?.trim() || null;
        const boundDeviceId = row.deviceId?.trim() || null;
        if (deviceId && boundDeviceId && boundDeviceId !== deviceId) {
          await createAuditEvent(client, {
            eventType: "device_token.reuse_rejected",
            metadata: {
              attemptedDeviceId: deviceId,
              boundDeviceId,
              tokenPrefix: row.tokenPrefix,
            },
            organizationId: row.organizationId,
            targetId: row.id,
            targetType: "device_token",
          });
          return null;
        }
        if (currentStatus === "pending" && deviceId) {
          const occupied = await client.query<DeviceTokenRow>(`
            UPDATE device_tokens
            SET
              status = 'occupied',
              device_id = coalesce(device_id, $2),
              occupied_at = coalesce(occupied_at, $3),
              last_used_at = $3
            WHERE id = $1
            RETURNING
              id,
              organization_id AS "organizationId",
              device_id AS "deviceId",
              name,
              token_prefix AS "tokenPrefix",
              status,
              created_at AS "createdAt",
              expires_at AS "expiresAt",
              occupied_at AS "occupiedAt",
              revoked_at AS "revokedAt",
              last_used_at AS "lastUsedAt"
          `, [row.id, deviceId, now]);
          const occupiedRow = occupied.rows[0];
          await createAuditEvent(client, {
            eventType: "device_token.occupied",
            metadata: {
              deviceId,
              tokenPrefix: occupiedRow.tokenPrefix,
            },
            organizationId: occupiedRow.organizationId,
            targetId: occupiedRow.id,
            targetType: "device_token",
          });
          return toDeviceTokenVerification(occupiedRow, now);
        }
        const touched = await client.query<DeviceTokenRow>(`
          UPDATE device_tokens
          SET last_used_at = $2
          WHERE id = $1
          RETURNING
            id,
            organization_id AS "organizationId",
            device_id AS "deviceId",
            name,
            token_prefix AS "tokenPrefix",
            status,
            created_at AS "createdAt",
            expires_at AS "expiresAt",
            occupied_at AS "occupiedAt",
            revoked_at AS "revokedAt",
            last_used_at AS "lastUsedAt"
        `, [row.id, now]);
        return toDeviceTokenVerification(touched.rows[0], now);
      });
    },
    createAuditEvent(input) {
      return createAuditEvent(pool, input);
    },
    async listAuditEvents(input) {
      const values: unknown[] = [input.organizationId, input.limit ?? 100];
      const conditions = ["organization_id = $1"];
      if (input.eventType) {
        values.push(input.eventType);
        conditions.push(`event_type = $${values.length}`);
      }
      const result = await pool.query<AuditEventRow>(`
        SELECT
          id,
          organization_id AS "organizationId",
          actor_user_id AS "actorUserId",
          event_type AS "eventType",
          target_type AS "targetType",
          target_id AS "targetId",
          metadata,
          created_at AS "createdAt"
        FROM organization_audit_events
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `, values);
      return result.rows.map(toAuditEvent);
    },
    close() {
      return pool.end();
    },
  };
}

async function listOrganizationsForUser(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  userId: string,
): Promise<AuthOrganizationMembership[]> {
  const result = await client.query<AuthOrganizationMembership>(`
    SELECT
      m.id,
      m.organization_id AS "organizationId",
      o.name,
      o.slug,
      m.role
    FROM organization_members m
    INNER JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = $1
      AND m.status = 'active'
    ORDER BY o.name
  `, [userId]);
  return result.rows;
}

interface DeviceTokenRow {
  createdAt?: Date;
  deviceId?: string | null;
  expiresAt?: Date | null;
  id: string;
  lastUsedAt?: Date | null;
  name: string;
  occupiedAt?: Date | null;
  organizationId: string;
  revokedAt?: Date | null;
  status: AuthDeviceTokenStatus;
  tokenPrefix: string;
}

interface AuditEventRow {
  actorUserId?: string | null;
  createdAt: Date;
  eventType: AuthAuditEventType;
  id: string;
  metadata: Record<string, unknown>;
  organizationId?: string | null;
  targetId?: string | null;
  targetType?: string | null;
}

function toDeviceTokenSummary(row: DeviceTokenRow, now = new Date()): AuthDeviceTokenSummary {
  return {
    createdAt: row.createdAt,
    deviceId: row.deviceId,
    expiresAt: row.expiresAt,
    id: row.id,
    lastUsedAt: row.lastUsedAt,
    name: row.name,
    occupiedAt: row.occupiedAt,
    organizationId: row.organizationId,
    revokedAt: row.revokedAt,
    status: resolveDeviceTokenStatus(row, now),
    tokenPrefix: row.tokenPrefix,
  };
}

function toDeviceTokenVerification(row: DeviceTokenRow, now: Date): AuthDeviceTokenVerification {
  const summary = toDeviceTokenSummary(row, now);
  return {
    deviceId: summary.deviceId,
    id: summary.id,
    organizationId: summary.organizationId,
    status: summary.status,
    tokenPrefix: summary.tokenPrefix,
  };
}

function resolveDeviceTokenStatus(row: DeviceTokenRow, now: Date): AuthDeviceTokenStatus {
  if (row.status === "revoked" || row.revokedAt) return "revoked";
  if (row.status === "expired" || (row.expiresAt && row.expiresAt <= now)) return "expired";
  if (row.status === "occupied" || row.occupiedAt) return "occupied";
  return "pending";
}

async function createAuditEvent(
  client: Pick<pg.Pool | pg.PoolClient, "query">,
  input: {
    actorUserId?: string | null;
    eventType: AuthAuditEventType;
    metadata?: Record<string, unknown>;
    organizationId?: string | null;
    targetId?: string | null;
    targetType?: string | null;
  },
): Promise<AuthAuditEvent> {
  const result = await client.query<AuditEventRow>(`
    INSERT INTO organization_audit_events (
      id, organization_id, actor_user_id, event_type, target_type, target_id, metadata
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING
      id,
      organization_id AS "organizationId",
      actor_user_id AS "actorUserId",
      event_type AS "eventType",
      target_type AS "targetType",
      target_id AS "targetId",
      metadata,
      created_at AS "createdAt"
  `, [
    createId("aud"),
    input.organizationId ?? null,
    input.actorUserId ?? null,
    input.eventType,
    input.targetType ?? null,
    input.targetId ?? null,
    JSON.stringify(input.metadata ?? {}),
  ]);
  return toAuditEvent(result.rows[0]);
}

function toAuditEvent(row: AuditEventRow): AuthAuditEvent {
  return {
    actorUserId: row.actorUserId,
    createdAt: row.createdAt,
    eventType: row.eventType,
    id: row.id,
    metadata: row.metadata ?? {},
    organizationId: row.organizationId,
    targetId: row.targetId,
    targetType: row.targetType,
  };
}

async function withTransaction<T>(
  pool: InstanceType<typeof Pool>,
  operation: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function maskEmail(email: string): string {
  const [local = "", domain = ""] = normalizeEmail(email).split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}
