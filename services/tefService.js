const koffi = require('koffi');
const path = require('path');

// 1. Caminho da DLL
const dllPath = path.join(__dirname, '..', 'tef', 'CliSiTef64.dll');

// 2. Carregar a DLL
let lib;
try {
    lib = koffi.load(dllPath);
} catch (e) {
    console.error("Erro ao carregar DLL do Sitef:", e);
}

// 3. Mapear as funções (Ponteiros no Koffi são mais simples)
// 'int' vira 'int'
// 'string' vira 'str' (para entrada) ou 'char *'
// Ponteiros de saída viram 'char *' ou buffers

const ConfiguraIntSiTefInterativo = lib.func('int ConfiguraIntSiTefInterativo(str, str, str, int)');
const IniciaFuncaoSiTefInterativo = lib.func('int IniciaFuncaoSiTefInterativo(int, str, str, str, str, str, str)');
const ContinuaFuncaoSiTefInterativo = lib.func('int ContinuaFuncaoSiTefInterativo(_Out_ char * proximoComando, _In_ int tamanhoComando, _Out_ char * tipoCampo, _Out_ char * dadoCampo, _In_ int tamanhoDado, int reservado)');

// Função wrapper para configurar
function configurarTEF() {
    if (!lib) return;
    
    // IP, Loja, Terminal, Reservado
    const resultado = ConfiguraIntSiTefInterativo("127.0.0.1", "00000000", "SE000001", 0);
    console.log("Resultado Configuração:", resultado);
    return resultado;
}

module.exports = { configurarTEF };