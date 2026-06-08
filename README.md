# NexPlay TV 📺 - Backend Server

This is the backend server for NexPlay TV. It serves as the API and a secure proxy for streaming HLS (`.m3u8`) files without exposing the source URL, thus avoiding CORS issues.

## 🚀 Key Features

- **Secure Stream Proxy:** The Node.js backend fetches the M3U8 manifest and proxies the stream data, protecting the original source URL.
- **Advanced Dashboard API:** Provides real-time analytics data for the admin panel.
- **Channel Manager:** Full CRUD (Create, Read, Update, Delete) for channels via MongoDB.
- **Auto-Fetch Logo:** Automatically generates a beautiful avatar logo for channels that lack one.
- **Audit Logs & Automation:** Monitor system events, contact messages, and run periodic cron jobs.

## 🛠️ Tech Stack

- Node.js & Express
- MongoDB & Mongoose (Database)
- CORS & node-fetch/axios (Proxying streams)
- JWT (Admin Authentication)

## ⚙️ Local Development Setup

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) installed and a MongoDB database (either local or MongoDB Atlas).

### Setup Steps
1. Install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file and add the following:
   ```env
   PORT=5050
   MONGO_URI=
   JWT_SECRET=
   ```
3. Start the backend server:
   ```bash
   npm run dev
   # or
   node index.js
   ```

## 🌐 Deployment (Render)
Deploy this directory as a "Web Service" on platforms like Render.
Make sure to set the Environment Variables (`MONGO_URI`, `JWT_SECRET`) in your deployment dashboard.
