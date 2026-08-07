import { jsPDF } from 'jspdf';

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getImageFormat(file, dataUrl) {
  if (file.type === 'image/png' || dataUrl.startsWith('data:image/png')) {
    return 'PNG';
  }
  return 'JPEG';
}

function getOrientation(width, height) {
  return width > height ? 'landscape' : 'portrait';
}

export async function fileToDataUrl(file) {
  return readFileAsDataUrl(file);
}

export async function convertSingleImage(file, dataUrl) {
  const img = await loadImage(dataUrl);
  const { naturalWidth: width, naturalHeight: height } = img;
  const format = getImageFormat(file, dataUrl);
  const orientation = getOrientation(width, height);

  const pdf = new jsPDF({
    orientation,
    unit: 'px',
    format: [width, height],
    hotfixes: ['px_scaling'],
  });

  pdf.addImage(dataUrl, format, 0, 0, width, height, undefined, 'FAST');
  return pdf.output('blob');
}

export async function convertMergedImages(items) {
  if (items.length === 0) return null;

  let pdf = null;

  for (let i = 0; i < items.length; i++) {
    const { file, dataUrl } = items[i];
    const img = await loadImage(dataUrl);
    const { naturalWidth: width, naturalHeight: height } = img;
    const format = getImageFormat(file, dataUrl);
    const orientation = getOrientation(width, height);

    if (i === 0) {
      pdf = new jsPDF({
        orientation,
        unit: 'px',
        format: [width, height],
        hotfixes: ['px_scaling'],
      });
    } else {
      pdf.addPage([width, height], orientation);
    }

    pdf.addImage(dataUrl, format, 0, 0, width, height, undefined, 'FAST');
  }

  return pdf.output('blob');
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export async function downloadAllSequentially(items, delayMs = 400) {
  for (const item of items) {
    const blob = item.blob ?? item.pdfBlob;
    const name = item.name ?? item.customName;
    if (!blob) continue;
    downloadBlob(blob, name);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
}

export function stripExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot <= 0) return filename;
  return filename.slice(0, lastDot);
}
