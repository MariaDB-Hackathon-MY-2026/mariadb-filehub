const path = require('path');
const { embedText, describeImage, transcribeAudio } = require('./embed');

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.cpp', '.c', '.h', '.cs', '.php', '.swift',
  '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.html', '.css', '.scss', '.yaml', '.yml', '.toml', '.json', '.xml',
]);

function detectFileType(filename, mimeType) {
  const ext = path.extname(filename).toLowerCase();
  if (mimeType === 'application/pdf') return 'pdf';
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) return 'docx';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/') || ['.mp3', '.wav', '.m4a', '.ogg', '.flac'].includes(ext)) return 'audio';
  if (mimeType.startsWith('video/') || ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext)) return 'video';
  if (CODE_EXTENSIONS.has(ext)) return 'code';
  return 'other';
}

async function extractAndEmbed(buffer, filename, mimeType) {
  const fileType = detectFileType(filename, mimeType);
  let extractedText = null;
  let embedding;

  if (fileType === 'pdf') {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    extractedText = data.text;
    embedding = await embedText(extractedText);

  } else if (fileType === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    extractedText = result.value;
    embedding = await embedText(extractedText);

  } else if (fileType === 'image') {
    extractedText = await describeImage(buffer, mimeType);
    embedding = await embedText(extractedText);

  } else if (fileType === 'audio') {
    extractedText = await transcribeAudio(buffer, filename);
    embedding = await embedText(extractedText);

  } else if (fileType === 'video') {
    const fallback = `video file: ${filename} | type: ${mimeType}`;
    embedding = await embedText(fallback);

  } else if (fileType === 'code') {
    extractedText = buffer.toString('utf8');
    embedding = await embedText(extractedText);

  } else {
    const fallback = `filename: ${filename} | type: ${mimeType}`;
    embedding = await embedText(fallback);
  }

  return { fileType, extractedText, embedding };
}

module.exports = { extractAndEmbed };
