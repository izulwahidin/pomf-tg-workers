// Environment variables (set in Cloudflare Workers)
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_CHAT_ID: Chat/channel ID to store files
// - FILES: KV namespace binding

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB (Telegram's limit)
const TELEGRAM_API_BASE = 'https://api.telegram.org';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Upload route: POST /upload
  if (path === '/upload' && request.method === 'POST') {
    return handleUpload(request, url.origin);
  }

  // Download route: GET /f/{random_id}.{ext}
  if (path.startsWith('/f/')) {
    const publicId = path.slice(3); // Remove '/f/' prefix
    return handleDownload(publicId);
  }

  // Default 404
  return jsonResponse({ success: false, error: 'Not found' }, 404);
}

async function handleUpload(request, origin) {
  try {
    const contentType = request.headers.get('Content-Type') || '';
    
    if (!contentType.startsWith('multipart/form-data')) {
      return jsonResponse({ 
        success: false, 
        error: 'Invalid Content-Type. Must be multipart/form-data' 
      }, 400);
    }

    const formData = await request.formData();
    const files = formData.getAll('files[]').filter(f => f instanceof File);
    
    if (files.length === 0) {
      return jsonResponse({ success: false, error: 'No valid files uploaded' }, 400);
    }

    const results = await Promise.all(files.map(async file => {
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File ${file.name} exceeds 50MB limit`);
      }

      const publicId = generatePublicId(file.name);
      const hashPart = publicId.split('.')[0];

      // Use sendDocument for all file types
      const formDataTelegram = new FormData();
      formDataTelegram.append('chat_id', TELEGRAM_CHAT_ID);
      formDataTelegram.append('document', 
        new Blob([await file.arrayBuffer()], { type: file.type }), 
        file.name
      );

      const sendResponse = await fetch(
        `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        { method: 'POST', body: formDataTelegram }
      );

      const sendResult = await sendResponse.json();
      
      if (!sendResult.ok) {
        throw new Error(`Telegram API error: ${sendResult.description}`);
      }

      // Extract file info from document field
      const mediaObject = sendResult.result.document;
      if (!mediaObject?.file_id) {
        throw new Error('Failed to retrieve file ID from Telegram');
      }

      await FILES.put(publicId, mediaObject.file_id);

      return {
        hash: hashPart,
        name: file.name,
        url: `${origin}/f/${publicId}`,
        size: mediaObject.file_size
      };
    }));

    return jsonResponse({ success: true, files: results });

  } catch (error) {
    console.error('Upload error:', error);
    return jsonResponse({ 
      success: false, 
      error: error.message || 'Internal server error' 
    }, error.message.includes('exceeds') ? 400 : 500);
  }
}

async function handleDownload(publicId) {
  try {
    const fileId = await FILES.get(publicId);
    if (!fileId) {
      return jsonResponse({ success: false, error: 'File not found' }, 404);
    }

    const fileData = await fetchTelegramFile(fileId);
    if (!fileData.ok) {
      throw new Error('Telegram API error');
    }

    const fileUrl = `${TELEGRAM_API_BASE}/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
    const response = await fetch(fileUrl);

    const headers = new Headers(response.headers);
    headers.set('Content-Disposition', `attachment; filename="${publicId}"`);
    headers.set('Cache-Control', 'public, max-age=31536000');

    return new Response(response.body, { headers });

  } catch (error) {
    console.error('Download error:', error);
    return jsonResponse({ success: false, error: 'Download failed' }, 500);
  }
}

async function fetchTelegramFile(fileId) {
  const response = await fetch(
    `${TELEGRAM_API_BASE}/bot${TELEGRAM_BOT_TOKEN}/getFile`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId })
    }
  );
  
  return response.json();
}

function generatePublicId(filename) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }

  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex !== -1 && lastDotIndex < filename.length - 1) {
    const ext = filename.slice(lastDotIndex);
    return `${id}${ext}`;
  }

  return id;
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}