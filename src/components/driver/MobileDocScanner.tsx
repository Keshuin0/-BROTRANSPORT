import React, { useState, useEffect, useRef } from 'react';
import {
  Camera,
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  WifiOff,
  Loader2,
  X,
  Image as ImageIcon,
} from 'lucide-react';
import {
  ALLOWED_DOC_MIMES,
  DocumentTypeSchema,
  MAX_DOC_BYTES,
  type DocumentType,
} from '@bro/contracts';
import { enqueueOfflineSubmission } from '../../lib/offlineDb';

const COMPRESS_THRESHOLD_BYTES = Math.round(1.2 * 1024 * 1024); // 1.2 MB
const MAX_IMAGE_DIMENSION_PX = 1800;

export interface ScannerLoadOption {
  id: string;
  loadNumber: string;
  commodity?: string;
  status?: string;
}

export interface MobileDocScannerProps {
  loads?: ScannerLoadOption[];
  defaultLoadId?: string;
  defaultDocType?: DocumentType;
  uploadEndpoint?: string;
  onUploaded?: (result: {
    documentId?: string;
    sha256Hex?: string;
    queuedOffline?: boolean;
    docType: DocumentType;
    fileName: string;
  }) => void;
}

const DOC_TYPE_LABELS: Record<DocumentType, string> = {
  BOL: 'Bill of Lading (BOL)',
  POD: 'Signed Proof of Delivery (POD)',
  RATE_CON: 'Rate Confirmation',
  COMMERCIAL_INVOICE: 'Customs Commercial Invoice',
  PACKING_LIST: 'Cargo Packing List',
  LUMPER_RECEIPT: 'Lumper / Unloading Receipt',
  SCALE_TICKET: 'CAT / Axle Scale Ticket',
  FUEL_RECEIPT: 'IFTA Diesel Fuel Receipt',
  CUSTOMS_STAMP: 'CBSA / CBP Customs Stamp',
  CDL: 'Commercial Driver License (CDL)',
  MEDICAL_CARD: 'DOT / NSC Medical Certificate',
  COI: 'Certificate of Insurance (COI)',
  W9_CRA_BN: 'W-9 / CRA Business Number',
  DVIR_PHOTO: 'DVIR Safety Defect Photo',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function replaceExtension(filename: string, newExt: string): string {
  const idx = filename.lastIndexOf('.');
  const base = idx > 0 ? filename.slice(0, idx) : filename;
  return `${base}.${newExt}`;
}

async function loadImageSource(file: File): Promise<{
  width: number;
  height: number;
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
  cleanup: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(file);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (ctx, w, h) => ctx.drawImage(bitmap, 0, 0, w, h),
      cleanup: () => bitmap.close(),
    };
  }

  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        width: img.naturalWidth,
        height: img.naturalHeight,
        draw: (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h),
        cleanup: () => URL.revokeObjectURL(objectUrl),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Unable to decode captured image for compression.'));
    };
    img.src = objectUrl;
  });
}

async function prepareDocumentFile(file: File): Promise<{
  blob: Blob;
  fileName: string;
  originalBytes: number;
  finalBytes: number;
  compressed: boolean;
}> {
  // Always preserve PDFs untouched
  if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
    return {
      blob: file,
      fileName: file.name,
      originalBytes: file.size,
      finalBytes: file.size,
      compressed: false,
    };
  }

  const isSupportedDirect = (ALLOWED_DOC_MIMES as readonly string[]).includes(file.type);
  const needsCompression = file.type.startsWith('image/') && (file.size > COMPRESS_THRESHOLD_BYTES || !isSupportedDirect);

  if (!needsCompression) {
    return {
      blob: file,
      fileName: file.name,
      originalBytes: file.size,
      finalBytes: file.size,
      compressed: false,
    };
  }

  const source = await loadImageSource(file);
  try {
    const longest = Math.max(source.width, source.height);
    const scale = longest > MAX_IMAGE_DIMENSION_PX ? MAX_IMAGE_DIMENSION_PX / longest : 1;
    const targetWidth = Math.max(1, Math.round(source.width * scale));
    const targetHeight = Math.max(1, Math.round(source.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        blob: file,
        fileName: file.name,
        originalBytes: file.size,
        finalBytes: file.size,
        compressed: false,
      };
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    source.draw(ctx, targetWidth, targetHeight);

    const webpBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/webp', 0.82),
    );

    if (webpBlob && webpBlob.type === 'image/webp') {
      return {
        blob: webpBlob,
        fileName: replaceExtension(file.name, 'webp'),
        originalBytes: file.size,
        finalBytes: webpBlob.size,
        compressed: true,
      };
    }

    // Fallback to JPEG if browser canvas WebP encoder is unavailable
    const jpegBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.84),
    );
    if (jpegBlob) {
      return {
        blob: jpegBlob,
        fileName: replaceExtension(file.name, 'jpg'),
        originalBytes: file.size,
        finalBytes: jpegBlob.size,
        compressed: true,
      };
    }

    return {
      blob: file,
      fileName: file.name,
      originalBytes: file.size,
      finalBytes: file.size,
      compressed: false,
    };
  } finally {
    source.cleanup();
  }
}

export default function MobileDocScanner({
  loads = [],
  defaultLoadId = '',
  defaultDocType = 'BOL',
  uploadEndpoint = '/api/driver/documents/upload',
  onUploaded,
}: MobileDocScannerProps) {
  const [docType, setDocType] = useState<DocumentType>(defaultDocType);
  const [selectedLoadId, setSelectedLoadId] = useState<string>(defaultLoadId);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [compressionNote, setCompressionNote] = useState<string | null>(null);

  const [uploading, setUploading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [uploadSuccess, setUploadSuccess] = useState<{
    documentId: string;
    sha256Hex: string;
    fileName: string;
    docType: DocumentType;
  } | null>(null);
  const [offlineQueued, setOfflineQueued] = useState<{
    fileName: string;
    docType: DocumentType;
    sizeBytes: number;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!selectedLoadId && defaultLoadId) {
      setSelectedLoadId(defaultLoadId);
    }
  }, [defaultLoadId, selectedLoadId]);

  useEffect(() => {
    if (!selectedFile || !selectedFile.type.startsWith('image/')) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    setPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [selectedFile]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setErrorMsg(null);
    setUploadSuccess(null);
    setOfflineQueued(null);
    setCompressionNote(null);

    const file = e.target.files?.[0] ?? null;
    if (!file) {
      setSelectedFile(null);
      return;
    }
    if (file.size === 0) {
      setErrorMsg('Selected file is empty.');
      setSelectedFile(null);
      return;
    }
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    const isImage = file.type.startsWith('image/');
    if (!isPdf && !isImage) {
      setErrorMsg('Unsupported file type. Capture an image (JPEG/PNG/WebP) or select a PDF.');
      setSelectedFile(null);
      return;
    }
    if (isPdf && file.size > MAX_DOC_BYTES) {
      setErrorMsg(`PDF exceeds maximum ${MAX_DOC_BYTES / (1024 * 1024)} MB limit.`);
      setSelectedFile(null);
      return;
    }
    setSelectedFile(file);
  };

  const clearSelection = () => {
    setSelectedFile(null);
    setCompressionNote(null);
    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const handleUpload = async (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setUploadSuccess(null);
    setOfflineQueued(null);

    const parsedDocType = DocumentTypeSchema.safeParse(docType);
    if (!parsedDocType.success) {
      setErrorMsg(parsedDocType.error.issues[0]?.message || 'Invalid document type.');
      return;
    }

    if (!selectedFile) {
      setErrorMsg('Capture a photo or choose a PDF document first.');
      return;
    }

    setUploading(true);
    try {
      const prepared = await prepareDocumentFile(selectedFile);
      if (prepared.finalBytes > MAX_DOC_BYTES) {
        setErrorMsg(`Prepared document exceeds ${MAX_DOC_BYTES / (1024 * 1024)} MB limit.`);
        return;
      }

      if (prepared.compressed) {
        setCompressionNote(
          `Optimized image: ${formatFileSize(prepared.originalBytes)} → ${formatFileSize(prepared.finalBytes)} (${prepared.fileName})`,
        );
      }

      const queueOffline = async () => {
        await enqueueOfflineSubmission({
          kind: 'driver_document',
          endpoint: uploadEndpoint,
          payload: {
            docType: parsedDocType.data,
            ...(selectedLoadId ? { loadId: selectedLoadId } : {}),
          },
          fileBlob: prepared.blob,
          fileName: prepared.fileName,
        });
        setOfflineQueued({
          fileName: prepared.fileName,
          docType: parsedDocType.data,
          sizeBytes: prepared.finalBytes,
        });
        clearSelection();
        onUploaded?.({
          queuedOffline: true,
          docType: parsedDocType.data,
          fileName: prepared.fileName,
        });
      };

      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        await queueOffline();
        return;
      }

      const fd = new FormData();
      fd.append('file', prepared.blob, prepared.fileName);
      fd.append('docType', parsedDocType.data);
      if (selectedLoadId) {
        fd.append('loadId', selectedLoadId);
      }

      let res: Response;
      try {
        res = await fetch(uploadEndpoint, { method: 'POST', body: fd });
      } catch (err) {
        if (err instanceof TypeError) {
          await queueOffline();
          return;
        }
        throw err;
      }

      const data = (await res.json().catch(() => ({}))) as {
        success?: boolean;
        documentId?: string;
        sha256Hex?: string;
        error?: string;
      };

      if (!res.ok) {
        setErrorMsg(data.error || `Document upload failed (HTTP ${res.status}).`);
        return;
      }

      setUploadSuccess({
        documentId: data.documentId ?? 'uploaded',
        sha256Hex: data.sha256Hex ?? '',
        fileName: prepared.fileName,
        docType: parsedDocType.data,
      });
      clearSelection();
      onUploaded?.({
        documentId: data.documentId,
        sha256Hex: data.sha256Hex,
        queuedOffline: false,
        docType: parsedDocType.data,
        fileName: prepared.fileName,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Unable to process or upload document.');
    } finally {
      setUploading(false);
    }
  };

  return (
    <form
      onSubmit={handleUpload}
      className="rounded-2xl surface-ceramic p-5 sm:p-6 space-y-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 pb-3.5">
        <div className="flex items-center gap-2.5">
          <Camera className="w-5 h-5 text-bro-cyan shrink-0" aria-hidden="true" />
          <h3 className="font-display text-base font-bold text-white tracking-tight">
            Mobile Document Capture &amp; OCR Vault
          </h3>
        </div>
        <span className="px-2.5 py-1 rounded-full bg-[#060912] border border-white/10 text-xs text-slate-300">
          Max 1800px WebP · PDF Preserved
        </span>
      </div>

      {/* Document Type & Linked Load */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label htmlFor="scanner-doc-type" className="block text-xs font-medium text-slate-300">
            Document Classification (14 Types)
          </label>
          <select
            id="scanner-doc-type"
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocumentType)}
            className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
          >
            {DocumentTypeSchema.options.map((opt) => (
              <option key={opt} value={opt}>
                {opt} — {DOC_TYPE_LABELS[opt]}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="scanner-load-id" className="block text-xs font-medium text-slate-300">
            Linked Load (Optional for Driver Credentials)
          </label>
          <select
            id="scanner-load-id"
            value={selectedLoadId}
            onChange={(e) => setSelectedLoadId(e.target.value)}
            className="w-full min-h-[44px] bg-[#060912] border border-white/15 rounded-xl px-3.5 py-2.5 text-sm text-white outline-none focus:border-bro-cyan"
          >
            <option value="">— Driver / Fleet General Document —</option>
            {loads.map((load) => (
              <option key={load.id} value={load.id}>
                {load.loadNumber}
                {load.commodity ? ` · ${load.commodity.slice(0, 32)}` : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Touch-Friendly Camera / File Capture Zone */}
      <div className="space-y-3">
        <label
          htmlFor="scanner-file-input"
          className="flex flex-col items-center justify-center gap-2.5 min-h-[144px] p-6 rounded-2xl border-2 border-dashed border-bro-cyan/40 hover:border-bro-cyan focus-within:ring-2 focus-within:ring-bro-cyan focus-within:border-bro-cyan bg-[#060912] text-center cursor-pointer transition-colors"
        >
          <div className="p-3 rounded-full bg-bro-cyan/10 border border-bro-cyan/30 text-bro-cyan">
            <Camera className="w-6 h-6" aria-hidden="true" />
          </div>
          <div className="font-display text-sm font-semibold text-white">
            Tap to Scan with Camera or Choose PDF
          </div>
          <p className="text-xs text-slate-300 max-w-sm leading-relaxed">
            Images over 1.2 MB are automatically resized (1800px max) &amp; WebP-compressed on-device before upload.
          </p>
          <input
            ref={inputRef}
            id="scanner-file-input"
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            onChange={handleFileChange}
            className="sr-only"
          />
        </label>

        {selectedFile && (
          <div className="flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-[#060912] border border-white/15">
            <div className="flex items-center gap-3 min-w-0">
              {previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Captured document preview"
                  className="w-14 h-14 rounded-xl object-cover border border-white/15 shrink-0"
                />
              ) : (
                <div className="w-14 h-14 rounded-xl bg-[#0b1120] border border-white/10 flex items-center justify-center shrink-0">
                  {selectedFile.type === 'application/pdf' ? (
                    <FileText className="w-6 h-6 text-bro-gold" aria-hidden="true" />
                  ) : (
                    <ImageIcon className="w-6 h-6 text-bro-cyan" aria-hidden="true" />
                  )}
                </div>
              )}
              <div className="min-w-0 space-y-0.5">
                <div className="font-mono text-xs font-semibold text-white truncate">{selectedFile.name}</div>
                <div className="text-xs text-slate-300 tabular-nums">
                  {formatFileSize(selectedFile.size)} · {selectedFile.type || 'document'}
                  {selectedFile.type.startsWith('image/') && selectedFile.size > COMPRESS_THRESHOLD_BYTES && (
                    <span className="ml-2 text-bro-cyan font-medium">Will optimize to WebP</span>
                  )}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={clearSelection}
              aria-label="Remove selected file"
              className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full border border-white/15 bg-[#0b1120] text-slate-300 hover:text-rose-200 hover:border-rose-400/60 focus-visible:ring-2 focus-visible:ring-bro-cyan cursor-pointer shrink-0 transition-colors"
            >
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {compressionNote && (
        <div className="p-3 rounded-xl bg-cyan-950/50 border border-bro-cyan/30 text-bro-cyan text-xs font-medium tabular-nums">
          {compressionNote}
        </div>
      )}

      {errorMsg && (
        <div
          role="alert"
          className="flex items-start gap-2 p-3.5 rounded-xl bg-rose-950/70 border border-rose-500/50 text-rose-200 text-xs font-medium"
        >
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" aria-hidden="true" />
          <span>{errorMsg}</span>
        </div>
      )}

      {uploadSuccess && (
        <div
          role="status"
          aria-live="polite"
          className="p-4 rounded-2xl bg-emerald-950/60 border border-emerald-500/40 text-emerald-100 text-xs space-y-1.5"
        >
          <div className="flex items-center gap-2 font-semibold text-emerald-300">
            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Uploaded to R2 Vault &amp; Queued for AI OCR</span>
          </div>
          <div className="font-mono text-xs text-emerald-100">
            {uploadSuccess.docType} · {uploadSuccess.fileName} · ID: {uploadSuccess.documentId}
          </div>
          {uploadSuccess.sha256Hex && (
            <div className="font-mono text-xs text-slate-300 break-all">
              SHA-256: {uploadSuccess.sha256Hex.slice(0, 32)}…
            </div>
          )}
        </div>
      )}

      {offlineQueued && (
        <div
          role="status"
          aria-live="polite"
          className="p-4 rounded-2xl bg-amber-950/60 border border-bro-gold text-amber-100 text-xs space-y-1.5"
        >
          <div className="flex items-center gap-2 font-semibold text-bro-gold">
            <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Saved to Offline Border Dead-Zone Vault</span>
          </div>
          <p className="text-xs text-amber-100/90 leading-relaxed">
            {offlineQueued.docType} ({offlineQueued.fileName}, {formatFileSize(offlineQueued.sizeBytes)}) is safely
            stored in IndexedDB and will upload automatically when cell service returns.
          </p>
        </div>
      )}

      <button
        type="submit"
        disabled={uploading || !selectedFile}
        className="w-full min-h-[48px] flex items-center justify-center gap-2 py-3.5 px-6 rounded-xl bg-bro-cyan hover:bg-cyan-300 text-black text-sm font-semibold disabled:opacity-40 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-bro-cyan"
      >
        {uploading ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin shrink-0" aria-hidden="true" />
            <span>Processing &amp; Uploading...</span>
          </>
        ) : (
          <>
            <Upload className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span>Upload Document Scan</span>
          </>
        )}
      </button>
    </form>
  );
}
