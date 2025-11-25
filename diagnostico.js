import axios from 'axios';

// ⚠️ Token de Produção (Verifique se é o mesmo da Render)
const TOKEN = 'APP_USR-434184288119812-112416-622965936e5edf32d8c37dc7da51c7c8-1684847114'; 

async function verUltimosPagamentos() {
    try {
        console.log("🕵️ Buscando os últimos 10 pagamentos da sua conta...");
        
        const response = await axios.get(
            'https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc&limit=10', 
            { headers: { 'Authorization': `Bearer ${TOKEN}` } }
        );

        const pagamentos = response.data.results;

        if (pagamentos.length === 0) {
            console.log("❌ Nenhum pagamento encontrado recentemente.");
        } else {
            console.log(`✅ Encontrados ${pagamentos.length} pagamentos recentes:\n`);
            pagamentos.forEach(p => {
                console.log(`💰 ID: ${p.id}`);
                console.log(`   Status: ${p.status} | Detalhe: ${p.status_detail}`);
                console.log(`   Valor: ${p.transaction_amount}`);
                console.log(`   Referência Externa (A Chave!): ${p.external_reference || '(VAZIO!)'}`);
                console.log(`   Data: ${p.date_created}`);
                console.log(`   Método: ${p.payment_method_id} (${p.payment_type_id})`);
                console.log("------------------------------------------------");
            });
        }
    } catch (error) {
        console.error("❌ Erro:", error.response ? error.response.data : error.message);
    }
}

verUltimosPagamentos();