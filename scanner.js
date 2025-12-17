import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Configuração de caminho
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Aponta para a DLL correta
const filePath = path.join(__dirname, 'tef', 'DPOSDRV.DLL');

console.log(`🕵️ Lendo arquivo: ${filePath}`);

try {
    if (!fs.existsSync(filePath)) {
        console.error("❌ ERRO: O arquivo DPOSDRV.DLL ainda não foi encontrado!");
        console.error("   Certifique-se que ele está na pasta: " + path.join(__dirname, 'tef'));
        process.exit(1);
    }

    const buffer = fs.readFileSync(filePath);
    
    // Filtra caracteres legíveis
    let currentString = "";
    const stringsFound = [];

    for (let i = 0; i < buffer.length; i++) {
        const byte = buffer[i];
        if ((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || (byte >= 48 && byte <= 57) || byte === 95) { 
            currentString += String.fromCharCode(byte);
        } else {
            if (currentString.length > 5) stringsFound.push(currentString);
            currentString = "";
        }
    }

    console.log("📝 --- POSSÍVEIS FUNÇÕES ENCONTRADAS ---");
    
    // Filtra palavras-chave comuns de D-TEF
    const funcoesProvaveis = stringsFound.filter(s => 
        (s.startsWith("Empresa") || s.startsWith("Config") || s.startsWith("Inicia") || s.startsWith("Finaliza") || s.includes("TEF") || s.includes("PDV"))
        && s.length < 30
    );

    console.log("👇 Verifique se estes nomes aparecem:");
    console.log(funcoesProvaveis.length > 0 ? funcoesProvaveis.join('\n') : "Nenhuma função óbvia encontrada com filtro. Veja os últimos itens:");
    
    if (funcoesProvaveis.length === 0) {
        console.log(stringsFound.slice(-50).join('\n'));
    }

} catch (e) {
    console.error("Erro fatal:", e.message);
}