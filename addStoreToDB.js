/**
 * Script para adicionar loja no banco de dados (PostgreSQL ou SQLite)
 * Usa a mesma configuração do server.js
 */

import knex from "knex";
import path from "path";
import dotenv from "dotenv";

// Carregar variáveis de ambiente
dotenv.config();

// Configuração do banco (igual ao server.js)
const dbConfig = process.env.DATABASE_URL
  ? {
      client: "pg",
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false },
      },
    }
  : {
      client: "sqlite3",
      connection: {
        filename: path.join(process.cwd(), "data", "kiosk.sqlite"),
      },
      useNullAsDefault: true,
    };

const db = knex(dbConfig);

// Dados da nova loja Sushi Man
const novaLoja = {
  id: "sushiman1",
  name: "Sushi Man",
  mp_access_token:
    "APP_USR-2380991543282785-120915-186724196695d70b571258710e1f9645-272635919",
  mp_device_id: "GERTEC_MP35P__8701012151238699",
};

async function addStore() {
  try {
    console.log("🔄 Conectando ao banco de dados...");
    console.log(
      `📊 Banco: ${
        process.env.DATABASE_URL ? "PostgreSQL (Render)" : "SQLite (Local)"
      }`
    );

    // Verificar se a loja já existe
    const existingStore = await db("stores").where({ id: novaLoja.id }).first();

    if (existingStore) {
      console.log(`\n⚠️  Loja "${novaLoja.id}" já existe!`);
      console.log("\n📋 Dados atuais:");
      console.log(`  Nome: ${existingStore.name}`);
      console.log(
        `  Token: ${existingStore.mp_access_token?.substring(0, 30)}...`
      );
      console.log(`  Device: ${existingStore.mp_device_id}`);

      console.log("\n🔄 Atualizando dados...");
      await db("stores").where({ id: novaLoja.id }).update({
        name: novaLoja.name,
        mp_access_token: novaLoja.mp_access_token,
        mp_device_id: novaLoja.mp_device_id,
      });
      console.log(`✅ Loja "${novaLoja.id}" atualizada com sucesso!`);
    } else {
      console.log(`\n➕ Adicionando nova loja "${novaLoja.id}"...`);
      await db("stores").insert(novaLoja);
      console.log(`✅ Loja "${novaLoja.id}" criada com sucesso!`);
    }

    // Mostrar todas as lojas
    console.log("\n📋 Lojas cadastradas no banco:");
    console.log("━".repeat(80));
    const allStores = await db("stores").select(
      "id",
      "name",
      "mp_access_token",
      "mp_device_id"
    );

    allStores.forEach((store) => {
      console.log(`\n🏪 ID: ${store.id}`);
      console.log(`   Nome: ${store.name}`);
      console.log(
        `   Token: ${
          store.mp_access_token
            ? "✅ Configurado (" +
              store.mp_access_token.substring(0, 20) +
              "...)"
            : "❌ Não configurado"
        }`
      );
      console.log(
        `   Device: ${
          store.mp_device_id ? `✅ ${store.mp_device_id}` : "❌ Sem maquininha"
        }`
      );
    });
    console.log("\n" + "━".repeat(80));

    console.log("\n✅ Loja pronta para uso!");
    console.log("\n📝 Configure no frontend (Vercel):");
    console.log(`   NEXT_PUBLIC_STORE_ID=sushiman1`);
  } catch (error) {
    console.error("\n❌ Erro ao adicionar loja:", error.message);
    console.error(error);
  } finally {
    await db.destroy();
  }
}

addStore();
