import express from "express";
import * as paymentController from "../controllers/paymentController.js";
import * as stoneController from "../controllers/stonePinpadController.js";
import { resolveStore } from "../middlewares/storeAuth.js";

const router = express.Router();

/**
 * Todas as rotas de pagamento requerem x-store-id header
 * O middleware resolveStore valida e anexa req.store com as credenciais
 */

// ========== MERCADO PAGO (COMENTADO) ==========
// PIX
// router.post("/create-pix", resolveStore, paymentController.createPix);

// Cartão via Point
// router.post("/create", resolveStore, paymentController.createCard);

// Status
// router.get("/status/:paymentId", resolveStore, paymentController.checkStatus);

// Cancelar
// router.delete("/cancel/:paymentId", resolveStore, paymentController.cancel);

// Point - Configuração
// router.post("/point/configure", resolveStore, paymentController.configurePoint);

// Point - Status
// router.get("/point/status", resolveStore, paymentController.getPointStatus);

// Limpar fila
// router.post("/clear-queue", resolveStore, paymentController.clearQueue);

// ========== STONE PINPAD (ATIVO) ==========
// Criar pagamento (crédito/débito)
router.post("/stone/create", stoneController.createStonePayment);

// Cancelar transação
router.post("/stone/cancel", stoneController.cancelStonePayment);

// Consultar status
router.get("/stone/status/:transactionId", stoneController.checkStoneStatus);

// Health check
router.get("/stone/health", stoneController.checkStoneHealth);

export default router;
