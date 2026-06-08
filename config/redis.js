const { Redis } = require('@upstash/redis');
require('dotenv').config();

let redis = null;

if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('Upstash Redis initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Upstash Redis:', err.message);
  }
} else {
  console.warn('Upstash Redis credentials missing. Caching will be disabled.');
}

module.exports = redis;
