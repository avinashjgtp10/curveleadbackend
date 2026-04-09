const express = require('express');
const router = express.Router();
const { getExpenses, getCategories, createCategory, createExpense, updateExpense, deleteExpense, getMonthlyReport } = require('../controllers/expenseController');
const { authenticate, adminOnly } = require('../middleware/auth');
const { tenantContext } = require('../middleware/tenant');

router.use(authenticate, tenantContext, adminOnly);

router.get('/categories', getCategories);
router.post('/categories', createCategory);
router.get('/report/monthly', getMonthlyReport);

router.get('/', getExpenses);
router.post('/', createExpense);
router.put('/:id', updateExpense);
router.delete('/:id', deleteExpense);

module.exports = router;
