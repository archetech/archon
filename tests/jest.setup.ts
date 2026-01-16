// Use fast PBKDF2 iterations for tests (1 instead of 100,000)
// This dramatically speeds up wallet encryption/decryption tests
process.env.PBKDF2_ITERATIONS = '1';
