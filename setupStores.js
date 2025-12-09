/**
 * Script para criar a tabela stores e adicionar a loja
 */

import knex from "knex";
import dotenv from "dotenv";

dotenv.config();

const db = knex({
  client: "pg",
  connection: {
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  },
});

async function setupStoresTable() {
  try {
    console.log("🔄 Conectando ao PostgreSQL...");

    // Verificar se a tabela stores existe
    const hasTable = await db.schema.hasTable("stores");

    if (!hasTable) {
      console.log("📋 Tabela 'stores' não existe. Criando...");

      await db.schema.createTable("stores", (table) => {
        table.string("id").primary();
        table.string("name").notNullable();
        table.text("mp_access_token");
        table.string("mp_device_id");
        table.timestamp("created_at").defaultTo(db.fn.now());
      });

      console.log("✅ Tabela 'stores' criada com sucesso!");
    } else {
      console.log("✅ Tabela 'stores' já existe");
    }

    // Verificar se loja-padrao existe
    const defaultStore = await db("stores")
      .where({ id: "loja-padrao" })
      .first();

    if (!defaultStore) {
      console.log("\n📋 Criando loja padrão...");
      await db("stores").insert({
        id: "loja-padrao",
        name: "Loja Padrão",
        mp_access_token: process.env.MP_ACCESS_TOKEN || null,
        mp_device_id: process.env.MP_DEVICE_ID || null,
      });
      console.log("✅ Loja padrão criada");
    }

    // Adicionar ou atualizar Sushi Man
    const sushiMan = await db("stores").where({ id: "sushiman1" }).first();

    const lojaData = {
      id: "sushiman1",
      name: "Sushi Man",
      mp_access_token:
        "APP_USR-2380991543282785-120915-186724196695d70b571258710e1f9645-272635919",
      mp_device_id: "GERTEC_MP35P__8701012151238699",
    };

    if (sushiMan) {
      console.log("\n🔄 Loja 'sushiman1' já existe. Atualizando...");
      await db("stores").where({ id: "sushiman1" }).update({
        name: lojaData.name,
        mp_access_token: lojaData.mp_access_token,
        mp_device_id: lojaData.mp_device_id,
      });
      console.log("✅ Loja 'sushiman1' atualizada!");
    } else {
      console.log("\n➕ Adicionando loja 'sushiman1'...");
      await db("stores").insert(lojaData);
      console.log("✅ Loja 'sushiman1' criada!");
    }

    // Listar todas as lojas
    console.log("\n" + "=".repeat(80));
    console.log("📋 LOJAS CADASTRADAS:");
    console.log("=".repeat(80));

    const allStores = await db("stores").select("*");

    allStores.forEach((store) => {
      console.log(`\n🏪 ID: ${store.id}`);
      console.log(`   Nome: ${store.name}`);
      console.log(
        `   Token: ${
          store.mp_access_token
            ? "✅ " + store.mp_access_token.substring(0, 30) + "..."
            : "❌ Não configurado"
        }`
      );
      console.log(`   Device: ${store.mp_device_id || "❌ Sem maquininha"}`);
      console.log(`   Criado em: ${store.created_at}`);
    });

    console.log("\n" + "=".repeat(80));
    console.log("\n✅ CONFIGURAÇÃO COMPLETA!");
    console.log("\n📝 No frontend (Vercel), configure:");
    console.log("   NEXT_PUBLIC_STORE_ID=sushiman1");
  } catch (error) {
    console.error("\n❌ Erro:", error.message);
    console.error(error);
  } finally {
    await db.destroy();
  }
}

setupStoresTable();
