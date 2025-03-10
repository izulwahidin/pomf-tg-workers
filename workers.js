// Environment variables (set in Cloudflare Workers)
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_CHAT_ID: Chat/channel ID to store files
// - FILES: KV namespace binding

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
      // Validate Content-Type header
      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.startsWith('multipart/form-data')) {
        return jsonError('Invalid Content-Type. Must be multipart/form-data', 400);
      }
  
      // Parse form data
      let formData;
      try {
        formData = await request.formData();
      } catch (e) {
        return jsonError('Malformed multipart form data', 400);
      }
  
      // Get file from form data
      const file = formData.get('files[]');
      if (!file || !(file instanceof File)) {
        return jsonError('No valid file uploaded', 400);
      }
  
      // Generate public ID with extension
      const publicId = generatePublicId(file.name);
      const hashPart = publicId.split('.')[0]; // Get the random part before extension
  
      // Send file to Telegram
      const formDataTelegram = new FormData();
      formDataTelegram.append('chat_id', TELEGRAM_CHAT_ID);
      formDataTelegram.append('document', file, file.name);
  
      const sendResponse = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
        { method: 'POST', body: formDataTelegram }
      );
  
      const sendResult = await sendResponse.json();
      
      if (!sendResult.ok) {
        console.error('Telegram API error:', sendResult.description);
        return jsonError('Upload failed', 500);
      }
  
      // Store mapping between public ID (with extension) and Telegram file ID
      await FILES.put(publicId, sendResult.result.document.file_id);
  
      // Build response with /f/ route
      const publicUrl = new URL(`/f/${publicId}`, request.url).href;
      const responseBody = {
        success: true,
        files: [{
          hash: hashPart,
          name: file.name,
          url: publicUrl,
          size: sendResult.result.document.file_size
        }]
      };
  
      return new Response(JSON.stringify(responseBody), {
        headers: { 'Content-Type': 'application/json' }
      });
  
    } catch (error) {
      console.error('Upload error:', error);
      return jsonError('Internal server error', 500);
    }
  }

async function handleDownload(request, publicId) {
  try {
    // Get Telegram file ID from KV using public ID with extension
    const fileId = await FILES.get(publicId);
    if (!fileId) return jsonError('File not found', 404);

    // Get file path from Telegram API
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

    // Stream file from Telegram
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileData.result.file_path}`;
    const response = await fetch(fileUrl);

    // Get original filename from Telegram's response
    const filename = fileData.result.file_path.split('/').pop();

    // Set headers with proper filename and caching
    const headers = new Headers(response.headers);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Cache-Control', 'public, max-age=31536000'); // 1 year

    return new Response(response.body, { headers });

  } catch (error) {
    console.error('Download error:', error);
    return jsonError('Download failed', 500);
  }
}

// Helper functions
function generatePublicId(filename) {
  // Generate 8-character random string with mixed case
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }

  // Append file extension if present
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