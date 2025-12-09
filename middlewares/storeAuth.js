/**
 * Middleware para resolver a loja (store) baseado no header x-store-id
 * Anexa as credenciais do Mercado Pago da loja em req.store
 */

import knex from "knex";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuração do banco (mesma do server.js)
const isProduction = process.env.NODE_ENV === "production";
const dbConfig = isProduction
  ? {
      client: "pg",
      connection: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    }
  : {
      client: "sqlite3",
      connection: { filename: path.join(__dirname, "..", "database.sqlite") },
      useNullAsDefault: true,
    };

const db = knex(dbConfig);

/**
 * Middleware que resolve a loja baseado no header x-store-id
 * @param {Object} req - Request do Express
 * @param {Object} res - Response do Express
 * @param {Function} next - Next middleware
 */
export async function resolveStore(req, res, next) {
  try {
    // 1. Tentar pegar store_id do header
    let storeId = req.headers["x-store-id"];

    // 2. Se não tiver, fazer fallback para 'loja-padrao'
    if (!storeId) {
      console.log(
        "⚠️ [STORE-AUTH] Header x-store-id ausente, usando loja-padrao"
      );
      storeId = "loja-padrao";
    }

    // 3. Buscar loja no banco de dados
    const store = await db("stores").where({ id: storeId }).first();

    if (!store) {
      console.error(`❌ [STORE-AUTH] Loja não encontrada: ${storeId}`);
      return res.status(404).json({
        error: "Loja não encontrada",
        storeId: storeId,
      });
    }

    // 4. Validar se a loja tem credenciais do Mercado Pago
    if (!store.mp_access_token) {
      console.warn(
        `⚠️ [STORE-AUTH] Loja ${storeId} sem credenciais do Mercado Pago`
      );
    }

    // 5. Anexar store ao request
    req.store = {
      id: store.id,
      name: store.name,
      mp_access_token: store.mp_access_token,
      mp_device_id: store.mp_device_id,
    };

    console.log(`✅ [STORE-AUTH] Loja resolvida: ${store.name} (${store.id})`);
    next();
  } catch (error) {
    console.error("❌ [STORE-AUTH] Erro ao resolver loja:", error);
    res.status(500).json({
      error: "Erro ao identificar loja",
      details: error.message,
    });
  }
}

/**
 * Middleware opcional que APENAS loga a loja sem bloquear
 * Útil para webhooks que não enviam x-store-id
 */
export async function resolveStoreOptional(req, res, next) {
  try {
    const storeId = req.headers["x-store-id"];

    if (storeId) {
      const store = await db("stores").where({ id: storeId }).first();

      if (store) {
        req.store = {
          id: store.id,
          name: store.name,
          mp_access_token: store.mp_access_token,
          mp_device_id: store.mp_device_id,
        };
        console.log(
          `✅ [STORE-AUTH] Loja resolvida: ${store.name} (${store.id})`
        );
      }
    } else {
      console.log("ℹ️ [STORE-AUTH] Header x-store-id ausente (opcional)");
    }

    next();
  } catch (error) {
    console.error("⚠️ [STORE-AUTH] Erro ao resolver loja (opcional):", error);
    next(); // Continua mesmo com erro
  }
}
