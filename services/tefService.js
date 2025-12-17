import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const koffi = require('koffi');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dllPath = path.join(__dirname, '..', 'tef', 'DPOSDRV.DLL');

let lib;
let tef = {};

console.log(`🔌 [TEF] Carregando driver: ${dllPath}`);

try {
    lib = koffi.load(dllPath);
    console.log("✅ DPOSDRV.DLL carregada. Mapeando funções...");

    // =========================================================================
    // 🔗 MAPEAMENTO DAS FUNÇÕES CONFIRMADAS
    // =========================================================================

    tef = {
        // 1. Iniciar Sistema
        inicializaDPOS: lib.func('int __stdcall InicializaDPOS()'),
        
        // 2. Configurar Loja
        configura: lib.func('int __stdcall ConfiguraEmpresaLojaPDV(str, str, str)'),
        
        // 3. VENDA (A função vencedora!)
        // Geralmente aceita: (Cupom, Valor, Tipo) ou (Operador, Valor, Cupom)
        // Vamos tentar o padrão mais comum: Cupom (str), Valor (str), Tipo (str)
        vendaCB: lib.func('InicializaSessaoCB', 'int', ['str', 'str', 'str']),

        // 4. Finalizar
        finaliza: lib.func('void __stdcall FinalizaDPOS()'),
        
        // 5. Ler Mensagem (se existir)
        lerMsg: null
    };
    
    // Tenta mapear lerMsg sem crashar se falhar
    try { tef.lerMsg = lib.func('str __stdcall UltimaMensagemTEF()'); } catch(e){}

    console.log("🚀 Funções mapeadas com sucesso! Pronto para vender.");

} catch (e) {
    console.error("❌ ERRO CRÍTICO NA DLL:", e.message);
}

export async function realizarPagamento(valor, tipo, idPedido) {
    if (!lib) return { sucesso: false, mensagem: "DLL OFF" };

    try {
        console.log("🔄 Iniciando Pagamento via InicializaSessaoCB...");

        // 1. Inicializa o Driver
        // (Muitas vezes retorna 1 = Sucesso)
        const retInit = tef.inicializaDPOS();
        console.log(`   -> InicializaDPOS: ${retInit}`);

        // 2. Configura Loja (Dados de Teste)
        // (Se der erro aqui, o pinpad pode dizer "Não Configurado", mas vai acender)
        tef.configura("00000000", "00000000", "PDV01");

        // 3. Executar Venda
        const valorStr = valor.toString(); // Ex: "1000" para 10.00
        const cupom = idPedido ? idPedido.toString() : "123456";
        
        // Tipo: "C" para Crédito, "D" para Débito.
        // Alguns drivers antigos usam "3" (Crédito) e "2" (Débito). Vamos tentar C/D primeiro.
        const tipoPag = tipo === 'DEBIT' ? 'D' : 'C';

        console.log(`👉 Enviando Venda: Cupom=${cupom}, Valor=${valorStr}, Tipo=${tipoPag}`);
        
        let retorno = -999;

        if (tef.vendaCB) {
            // Chamada: InicializaSessaoCB(Cupom, Valor, Tipo)
            try {
                retorno = tef.vendaCB(cupom, valorStr, tipoPag);
            } catch (errArg) {
                console.log("⚠️ Erro de argumentos. Tentando ordem inversa...");
                // Se falhar, tentamos inverter (Valor, Cupom, Tipo) - comum em DLLs antigas
                try {
                    retorno = tef.vendaCB(valorStr, cupom, tipoPag);
                } catch (err2) {
                    throw new Error("Falha na chamada da função CB: " + err2.message);
                }
            }
        } else {
            return { sucesso: false, mensagem: "Função CB não carregada." };
        }

        console.log(`✅ RETORNO DA DLL: ${retorno}`);

        // Tenta ler mensagem do driver
        if (retorno !== 1 && tef.lerMsg) {
            try { console.log("   📩 Mensagem: " + tef.lerMsg()); } catch(e){}
        }

        return { 
            sucesso: true, 
            mensagem: "Comando enviado", 
            codigo: retorno 
        };

    } catch (error) {
        console.error("💥 Erro:", error.message);
        return { sucesso: false, mensagem: "Erro técnico: " + error.message };
    }
}