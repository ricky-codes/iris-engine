import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SQLSTATE,
  TEST_DATABASE_URL,
  createTestDb,
  seedTenant,
  sfId,
  sqlState,
  type TestDb,
} from './helpers.js';

const ACTION = { sentiment: 1, tipification: 2, reply: 3 } as const;
const STATUS = { succeeded: 3, failed: 4 } as const;

async function addRequest(
  pool: pg.Pool,
  userId: string,
  action: keyof typeof ACTION,
  overrides: { status?: number; errorTypeId?: number | null } = {},
): Promise<string> {
  const { rows } = await pool.query<{ inference_request_id: string }>(
    `INSERT INTO inference_request
       (org_user_id, action_id, request_status_id, error_type_id, sf_record_id,
        payload_sha256, payload_bytes, received_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, 3617, now(), now()) RETURNING inference_request_id`,
    [
      userId,
      ACTION[action],
      overrides.status ?? STATUS.succeeded,
      overrides.errorTypeId ?? null,
      sfId('500'),
      randomBytes(32),
    ],
  );
  return rows[0]!.inference_request_id;
}

async function addPromptVersion(pool: pg.Pool, action: keyof typeof ACTION): Promise<number> {
  const prompt = await pool.query<{ prompt_id: number }>(
    `INSERT INTO prompt (action_id, tenant_id) VALUES ($1, NULL)
     ON CONFLICT (action_id, tenant_id) DO UPDATE SET action_id = EXCLUDED.action_id
     RETURNING prompt_id`,
    [ACTION[action]],
  );
  const version = await pool.query<{ prompt_version_id: number }>(
    `INSERT INTO prompt_version (prompt_id, version, system_template, is_active)
     VALUES ($1, (SELECT coalesce(max(version), 0) + 1 FROM prompt_version WHERE prompt_id = $1), 'tpl', false)
     RETURNING prompt_version_id`,
    [prompt.rows[0]!.prompt_id],
  );
  return version.rows[0]!.prompt_version_id;
}

async function addModel(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ llm_model_id: number }>(
    `INSERT INTO llm_model (ai_provider_id, code) VALUES (1, $1) RETURNING llm_model_id`,
    [`m-${randomBytes(3).toString('hex')}`],
  );
  return rows[0]!.llm_model_id;
}

async function addDimension(
  pool: pg.Pool,
  tenantId: string,
  key: string,
  position: number,
): Promise<number> {
  const { rows } = await pool.query<{ classification_dimension_id: number }>(
    `INSERT INTO classification_dimension (tenant_id, output_key, label, position)
     VALUES ($1, $2, $2, $3) RETURNING classification_dimension_id`,
    [tenantId, key, position],
  );
  return rows[0]!.classification_dimension_id;
}

describe.skipIf(TEST_DATABASE_URL === undefined)('pedidos e resultados', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });

  describe('inference_request', () => {
    it('um pedido falhado exige tipo de erro', async () => {
      const t = await seedTenant(db.pool);
      const code = await sqlState(
        addRequest(db.pool, t.userId, 'sentiment', { status: STATUS.failed }),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });

    it('um pedido bem-sucedido não pode ter tipo de erro', async () => {
      const t = await seedTenant(db.pool);
      const code = await sqlState(addRequest(db.pool, t.userId, 'sentiment', { errorTypeId: 12 }));
      expect(code).toBe(SQLSTATE.checkViolation);
    });

    it('um pedido falhado com erro é aceite', async () => {
      const t = await seedTenant(db.pool);
      await addRequest(db.pool, t.userId, 'sentiment', { status: STATUS.failed, errorTypeId: 12 });
    });

    it('recusa um id de registo que não tem 18 caracteres', async () => {
      const t = await seedTenant(db.pool);
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO inference_request
             (org_user_id, action_id, request_status_id, sf_record_id, payload_sha256, payload_bytes, received_at)
           VALUES ($1, 1, 3, '500gL00001HzOO5', $2, 10, now())`,
          [t.userId, randomBytes(32)],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });
  });

  describe('llm_call', () => {
    it('aceita um prompt da mesma ação do pedido', async () => {
      const t = await seedTenant(db.pool);
      const requestId = await addRequest(db.pool, t.userId, 'sentiment');
      const pv = await addPromptVersion(db.pool, 'sentiment');
      const model = await addModel(db.pool);
      await db.pool.query(
        `INSERT INTO llm_call (inference_request_id, attempt, prompt_version_id, requested_model_id,
                               input_tokens, cached_input_tokens, output_tokens, started_at)
         VALUES ($1, 1, $2, $3, 5210, 1800, 142, now())`,
        [requestId, pv, model],
      );
    });

    it('recusa um prompt de outra ação', async () => {
      const t = await seedTenant(db.pool);
      const requestId = await addRequest(db.pool, t.userId, 'sentiment');
      const pv = await addPromptVersion(db.pool, 'reply');
      const model = await addModel(db.pool);
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO llm_call (inference_request_id, attempt, prompt_version_id, requested_model_id, started_at)
           VALUES ($1, 1, $2, $3, now())`,
          [requestId, pv, model],
        ),
      );
      expect(code).toBe(SQLSTATE.integrityConstraintViolation);
    });

    it('recusa mais tokens em cache do que tokens de entrada', async () => {
      const t = await seedTenant(db.pool);
      const requestId = await addRequest(db.pool, t.userId, 'sentiment');
      const pv = await addPromptVersion(db.pool, 'sentiment');
      const model = await addModel(db.pool);
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO llm_call (inference_request_id, attempt, prompt_version_id, requested_model_id,
                                 input_tokens, cached_input_tokens, started_at)
           VALUES ($1, 1, $2, $3, 100, 200, now())`,
          [requestId, pv, model],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });
  });

  describe('sentimento', () => {
    it('guarda o resultado e os sinais', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'sentiment');
      await db.pool.query(
        `INSERT INTO sentiment_result (inference_request_id, sentiment_label_id, urgency_level_id, score, summary, recommended_tone)
         VALUES ($1, 3, 3, 0.86, 'Cliente apreensivo.', 'Empático e resolutivo')`,
        [id],
      );
      await db.pool.query(
        `INSERT INTO sentiment_signal (inference_request_id, position, signal)
         VALUES ($1, 1, 'Reporta movimento não reconhecido'), ($1, 2, 'Pede bloqueio')`,
        [id],
      );
      const { rows } = await db.pool.query(
        'SELECT 1 FROM sentiment_signal WHERE inference_request_id = $1',
        [id],
      );
      expect(rows).toHaveLength(2);
    });

    it('só existe para pedidos de sentimento', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'tipification');
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO sentiment_result (inference_request_id, sentiment_label_id, urgency_level_id, score, summary, recommended_tone)
           VALUES ($1, 2, 1, 0.5, 's', 't')`,
          [id],
        ),
      );
      expect(code).toBe(SQLSTATE.foreignKeyViolation);
    });

    it('recusa mais de cinco sinais e score fora de 0 a 1', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'sentiment');
      expect(
        await sqlState(
          db.pool.query(
            `INSERT INTO sentiment_result (inference_request_id, sentiment_label_id, urgency_level_id, score, summary, recommended_tone)
             VALUES ($1, 2, 1, 1.2, 's', 't')`,
            [id],
          ),
        ),
      ).toBe(SQLSTATE.checkViolation);

      await db.pool.query(
        `INSERT INTO sentiment_result (inference_request_id, sentiment_label_id, urgency_level_id, score, summary, recommended_tone)
         VALUES ($1, 2, 1, 0.5, 's', 't')`,
        [id],
      );
      expect(
        await sqlState(
          db.pool.query(
            `INSERT INTO sentiment_signal (inference_request_id, position, signal) VALUES ($1, 6, 'x')`,
            [id],
          ),
        ),
      ).toBe(SQLSTATE.checkViolation);
    });
  });

  describe('tipificação', () => {
    it('guarda um valor por nível, por ordem do cliente', async () => {
      const t = await seedTenant(db.pool);
      const tipo = await addDimension(db.pool, t.tenantId, 'tipo', 1);
      const sub = await addDimension(db.pool, t.tenantId, 'subTipo', 2);
      const id = await addRequest(db.pool, t.userId, 'tipification');
      await db.pool.query(
        `INSERT INTO tipification_result (inference_request_id, score, summary) VALUES ($1, 0.92, 'Fraude.')`,
        [id],
      );
      await db.pool.query(
        `INSERT INTO tipification_result_value (inference_request_id, classification_dimension_id, value, is_included)
         VALUES ($1, $2, 'Reclamação', true), ($1, $3, '', false)`,
        [id, tipo, sub],
      );
      const { rows } = await db.pool.query<{
        output_key: string;
        value: string;
        is_included: boolean;
      }>(
        `SELECT d.output_key, v.value, v.is_included
         FROM tipification_result_value v
         JOIN classification_dimension d USING (classification_dimension_id)
         WHERE v.inference_request_id = $1 ORDER BY d.position`,
        [id],
      );
      expect(rows).toEqual([
        { output_key: 'tipo', value: 'Reclamação', is_included: true },
        { output_key: 'subTipo', value: '', is_included: false },
      ]);
    });

    it('recusa is_included verdadeiro com valor vazio', async () => {
      const t = await seedTenant(db.pool);
      const tipo = await addDimension(db.pool, t.tenantId, 'tipo', 1);
      const id = await addRequest(db.pool, t.userId, 'tipification');
      await db.pool.query(
        `INSERT INTO tipification_result (inference_request_id, score, summary) VALUES ($1, 0.5, 's')`,
        [id],
      );
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO tipification_result_value (inference_request_id, classification_dimension_id, value, is_included)
           VALUES ($1, $2, '', true)`,
          [id, tipo],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });

    it('recusa um nível de outro cliente', async () => {
      const mine = await seedTenant(db.pool);
      const other = await seedTenant(db.pool);
      const foreignDim = await addDimension(db.pool, other.tenantId, 'tipo', 1);
      const id = await addRequest(db.pool, mine.userId, 'tipification');
      await db.pool.query(
        `INSERT INTO tipification_result (inference_request_id, score, summary) VALUES ($1, 0.5, 's')`,
        [id],
      );
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO tipification_result_value (inference_request_id, classification_dimension_id, value, is_included)
           VALUES ($1, $2, 'Reclamação', true)`,
          [id, foreignDim],
        ),
      );
      expect(code).toBe(SQLSTATE.integrityConstraintViolation);
    });

    it('um cliente pode ter um número qualquer de níveis', async () => {
      const t = await seedTenant(db.pool);
      for (let i = 1; i <= 6; i++) await addDimension(db.pool, t.tenantId, `nivel${i}`, i);
      const { rows } = await db.pool.query(
        'SELECT 1 FROM classification_dimension WHERE tenant_id = $1',
        [t.tenantId],
      );
      expect(rows).toHaveLength(6);
    });
  });

  describe('resposta sugerida', () => {
    it('guarda os parâmetros de um email recebido e a resposta', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'reply');
      await db.pool.query(
        `INSERT INTO reply_request (inference_request_id, message_item_type_id, sf_item_id, is_incoming, tom, simpatia, formalidade)
         VALUES ($1, 1, '02sgL0000042fZRQAY', true, 50, 70, 50)`,
        [id],
      );
      await db.pool.query(
        `INSERT INTO reply_result (inference_request_id, reply, subject, recommended_tone)
         VALUES ($1, 'Bom dia, ...', 'RE: Movimento não reconhecido', 'Empático')`,
        [id],
      );
    });

    it('is_published só se aplica a comentários', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'reply');
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO reply_request (inference_request_id, message_item_type_id, sf_item_id, is_published, tom, simpatia, formalidade)
           VALUES ($1, 1, '02sgL0000042fZRQAY', true, 50, 70, 50)`,
          [id],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });

    it('recusa sliders fora de 0 a 100', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'reply');
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO reply_request (inference_request_id, message_item_type_id, sf_item_id, is_incoming, tom, simpatia, formalidade)
           VALUES ($1, 1, '02sgL0000042fZRQAY', true, 101, 70, 50)`,
          [id],
        ),
      );
      expect(code).toBe(SQLSTATE.checkViolation);
    });

    it('não existe resposta sem os parâmetros que a geraram', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'reply');
      const code = await sqlState(
        db.pool.query(
          `INSERT INTO reply_result (inference_request_id, reply, recommended_tone) VALUES ($1, 'x', 'y')`,
          [id],
        ),
      );
      expect(code).toBe(SQLSTATE.foreignKeyViolation);
    });

    it('subject é vazio por omissão, nunca nulo', async () => {
      const t = await seedTenant(db.pool);
      const id = await addRequest(db.pool, t.userId, 'reply');
      await db.pool.query(
        `INSERT INTO reply_request (inference_request_id, message_item_type_id, sf_item_id, is_published, tom, simpatia, formalidade)
         VALUES ($1, 2, '00agL00000EXIR8QAP', true, 50, 50, 50)`,
        [id],
      );
      await db.pool.query(
        `INSERT INTO reply_result (inference_request_id, reply, recommended_tone) VALUES ($1, 'Texto.', 'Neutro')`,
        [id],
      );
      const { rows } = await db.pool.query<{ subject: string }>(
        'SELECT subject FROM reply_result WHERE inference_request_id = $1',
        [id],
      );
      expect(rows[0]?.subject).toBe('');
    });
  });

  describe('apagamento de um utilizador', () => {
    it('remove pedidos, chamadas e resultados dele e preserva os dos outros', async () => {
      const gone = await seedTenant(db.pool);
      const kept = await seedTenant(db.pool);

      const goneId = await addRequest(db.pool, gone.userId, 'sentiment');
      await db.pool.query(
        `INSERT INTO sentiment_result (inference_request_id, sentiment_label_id, urgency_level_id, score, summary, recommended_tone)
         VALUES ($1, 2, 1, 0.5, 's', 't')`,
        [goneId],
      );
      await db.pool.query(
        `INSERT INTO sentiment_signal (inference_request_id, position, signal) VALUES ($1, 1, 'x')`,
        [goneId],
      );
      const keptId = await addRequest(db.pool, kept.userId, 'sentiment');

      await db.pool.query('DELETE FROM org_user WHERE org_user_id = $1', [gone.userId]);

      const left = await db.pool.query<{ id: string }>(
        `SELECT inference_request_id AS id FROM inference_request WHERE inference_request_id = ANY($1)`,
        [[goneId, keptId]],
      );
      expect(left.rows.map((r) => r.id)).toEqual([keptId]);
      const signals = await db.pool.query(
        'SELECT 1 FROM sentiment_signal WHERE inference_request_id = $1',
        [goneId],
      );
      expect(signals.rowCount).toBe(0);
    });
  });
});
