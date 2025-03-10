// Environment variables (set in Cloudflare Workers)
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_CHAT_ID: Chat/channel ID to store files
// - FILES: KV namespace binding

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB (Telegram's limit)

addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request));
  });
  
  async function handleRequest(request) {
    const url = new URL(request.url);
  
    // Upload route: POST /upload
    if (url.pathname === '/upload' && request.method === 'POST') {
      return handleUpload(request);
    }
  
    // Download route: GET /f/{random_id}.{ext}
    else if (url.pathname.startsWith('/f/')) {
      const publicId = url.pathname.slice(3); // Remove '/f/' prefix
      return handleDownload(request, publicId);
    }
  
    // Default 404
    return jsonError('Not found', 404);
  }
  
async function handleUpload(request) {
  try {
    const contentType = request.headers.get('Content-Type') || '';
    if (!contentType.startsWith('multipart/form-data')) {
      return jsonError('Invalid Content-Type. Must be multipart/form-data', 400);
    }

    const formData = await request.formData();
    const files = formData.getAll('files[]').filter(f => f instanceof File);
    
    if (files.length === 0) {
      return jsonError('No valid files uploaded', 400);
    }

    const results = [];
    for (const file of files) {
      if (file.size > MAX_FILE_SIZE) {
        return jsonError(`File ${file.name} exceeds 50MB limit`, 400);
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
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        { method: 'POST', body: formDataTelegram }
      );

      const sendResult = await sendResponse.json();
      
      if (!sendResult.ok) {
        return jsonError(`Telegram API error: ${sendResult.description}`, 500);
      }

      // Extract file info from document field
      const mediaObject = sendResult.result.document;
      if (!mediaObject?.file_id) {
        return jsonError('Failed to retrieve file ID from Telegram', 500);
      }

      await FILES.put(publicId, mediaObject.file_id);

      results.push({
        hash: hashPart,
        name: file.name,
        url: `${new URL(request.url).origin}/f/${publicId}`,
        size: mediaObject.file_size
      });
    }

    return new Response(JSON.stringify({
      success: true,
      files: results
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Upload error:', error);
    return jsonError('Internal server error', 500);
  }
}

async function handleDownload(request, publicId) {
  try {
    const fileId = await FILES.get(publicId);
    if (!fileId) return jsonError('File not found', 404);

    const fileResponse = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId })
      }
    );

    const fileData = await fileResponse.json();
    if (!fileData.ok) throw new Error('Telegram API error');

    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
    const response = await fetch(fileUrl);

    const headers = new Headers(response.headers);
    headers.set('Content-Disposition', `attachment; filename="${publicId}"`);
    headers.set('Cache-Control', 'public, max-age=31536000');

    return new Response(response.body, { headers });

  } catch (error) {
    console.error('Download error:', error);
    return jsonError('Download failed', 500);
  }
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

function jsonError(message, status) {
  return new Response(JSON.stringify({
    success: false,
    error: message
  }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
