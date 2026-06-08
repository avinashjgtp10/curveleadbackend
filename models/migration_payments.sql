-- Align existing plan records with the Razorpay checkout catalog.
UPDATE plans SET price = 9, max_leads = 100, max_users = 1
WHERE name = 'Starter';

UPDATE plans SET price = 29, max_leads = 1000, max_users = 5
WHERE name = 'Growth';

UPDATE plans SET price = 0, max_leads = -1, max_users = -1
WHERE name = 'Pro';
