"use client";

import { useState, useRef, useCallback } from "react";
import { post, get, del } from "@/lib/api.client";

// ─── Constants ────────────────────────────────────────────────────────────────
const SIMPLE_THRESHOLD = 100 * 1024 * 1024;
const MAX_PARALLEL_PARTS = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// ─── Types ────────────────────────────────────────────────────────────────────
export type UploadStatus = "idle" | "uploading" | "completing" | "done" | "error" | "aborted";

export interface UploadItem {
  id: string;
  file: File;
  folderId: string;
  status: UploadStatus;
  progress: number;
  uploadedBytes: number;
  totalBytes: number;
  speed: number;
  timeRemaining: number | null;
  error: string | null;
  sessionId?: string;
  strategy?: "simple" | "multipart";
}

export interface PendingSession {
  sessionId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  totalParts: number;
  uploadedParts: number;
  percentComplete: number;
  uploadedBytes: number;
  expiresAt: string;
}

// ─── Abort sentinel ───────────────────────────────────────────────────────────
class AbortError extends Error {
  constructor() {
    super("Upload aborted");
    this.name = "AbortError";
  }
}

function isAbortError(err: unknown): err is AbortError {
  return err instanceof AbortError || (err instanceof Error && err.name === "AbortError");
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }

    const timer = setTimeout(resolve, ms);

    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new AbortError());
      },
      { once: true },
    );
  });
}

function putToR2(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress?: (deltaBytes: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new AbortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", body.type || "application/octet-stream");

    if (onProgress) {
      let lastLoaded = 0;
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable) {
          const delta = e.loaded - lastLoaded;
          lastLoaded = e.loaded;
          onProgress(delta);
        }
      });
    }

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag") ?? "";
        resolve(etag);
      } else {
        reject(new Error(`R2 PUT failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
    xhr.addEventListener("abort", () => reject(new AbortError()));

    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    xhr.addEventListener("loadend", () => signal.removeEventListener("abort", onAbort));

    xhr.send(body);
  });
}

async function putWithRetry(
  url: string,
  body: Blob,
  signal: AbortSignal,
  onProgress?: (delta: number) => void,
): Promise<string> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await putToR2(url, body, signal, onProgress);
    } catch (err) {
      if (isAbortError(err)) throw err;
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_MS * Math.pow(2, attempt), signal);
    }
  }
  throw new Error("Unreachable");
}

// ─── Hook ─────────────────────────────────────────────────────────────────────
export function useUpload() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [pendingSessions, setPendingSessions] = useState<PendingSession[]>([]);

  const speedTrackers = useRef<Map<string, { bytes: number; ts: number }>>(new Map());
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  // ─── Helpers ──────────────────────────────────────────────────────────────
  const updateItem = useCallback((id: string, patch: Partial<UploadItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const cleanupItem = useCallback((id: string) => {
    speedTrackers.current.delete(id);
    abortControllers.current.delete(id);
  }, []);

  const onDelta = useCallback((id: string, delta: number) => {
    const now = Date.now();
    const tracker = speedTrackers.current.get(id);
    if (!tracker) return;

    tracker.bytes += delta;
    const elapsed = (now - tracker.ts) / 1000;

    if (elapsed >= 0.5) {
      const speed = tracker.bytes / elapsed;
      tracker.bytes = 0;
      tracker.ts = now;

      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          const uploaded = it.uploadedBytes + delta;
          const remaining = it.totalBytes - uploaded;
          return {
            ...it,
            uploadedBytes: uploaded,
            progress: Math.min(99, Math.round((uploaded / it.totalBytes) * 100)),
            speed,
            timeRemaining: speed > 0 ? Math.ceil(remaining / speed) : null,
          };
        }),
      );
    } else {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          const uploaded = it.uploadedBytes + delta;
          return {
            ...it,
            uploadedBytes: uploaded,
            progress: Math.min(99, Math.round((uploaded / it.totalBytes) * 100)),
          };
        }),
      );
    }
  }, []);

  // ─── Simple upload ────────────────────────────────────────────────────────
  const simpleUpload = useCallback(
    async (itemId: string, file: File, folderId: string, signal: AbortSignal) => {
      try {
        const presignRes = await post<{ uploadUrl: string; r2Key: string; expiresIn: number }>({
          path: "/upload/presign",
          body: { folderId, fileName: file.name, mimeType: file.type, sizeBytes: file.size },
        });

        if (signal.aborted) throw new AbortError();

        if (presignRes.status === "error") {
          updateItem(itemId, { status: "error", error: presignRes.message });
          return;
        }

        const { uploadUrl, r2Key } = presignRes.data!;

        await putWithRetry(uploadUrl, file, signal, (delta) => onDelta(itemId, delta));

        if (signal.aborted) throw new AbortError();

        updateItem(itemId, { status: "completing", progress: 99 });

        const confirmRes = await post({
          path: "/upload/confirm",
          body: { r2Key, folderId, fileName: file.name, mimeType: file.type, sizeBytes: file.size },
        });

        if (signal.aborted) throw new AbortError();

        if (confirmRes.status === "error") {
          updateItem(itemId, { status: "error", error: confirmRes.message });
          return;
        }

        updateItem(itemId, { status: "done", progress: 100, timeRemaining: null });
      } catch (err) {
        if (isAbortError(err)) {
          updateItem(itemId, { status: "aborted", error: null });
        } else {
          updateItem(itemId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      } finally {
        cleanupItem(itemId);
      }
    },
    [updateItem, onDelta, cleanupItem],
  );

  // ─── Multipart upload ─────────────────────────────────────────────────────
  const multipartUpload = useCallback(
    async (itemId: string, file: File, folderId: string | null, signal: AbortSignal, existingSessionId?: string) => {
      let sessionId: string | undefined;

      try {
        type PartInfo = {
          partNumber: number;
          uploadUrl: string;
          etag?: string;
          uploadedAt?: string;
          sizeBytes?: number;
        };

        let totalParts: number;
        let partSize: number;
        let parts: PartInfo[];

        if (existingSessionId) {
          const res = await get<{
            sessionId: string;
            totalParts: number;
            partSize: number;
            parts: PartInfo[];
          }>({ path: `/upload/multipart/${existingSessionId}/resume` });

          if (signal.aborted) throw new AbortError();

          if (res.status === "error") {
            updateItem(itemId, { status: "error", error: res.message });
            return;
          }

          ({ sessionId, totalParts, partSize, parts } = res.data!);

          const doneParts = parts.filter((p) => p.uploadedAt);
          const doneBytes = doneParts.reduce((sum, p) => sum + (p.sizeBytes ?? partSize), 0);

          updateItem(itemId, {
            sessionId,
            uploadedBytes: doneBytes,
            progress: Math.min(99, Math.round((doneBytes / file.size) * 100)),
          });
        } else {
          const res = await post<{
            sessionId: string;
            totalParts: number;
            partSize: number;
            parts: PartInfo[];
          }>({
            path: "/upload/multipart/init",
            body: { folderId, fileName: file.name, mimeType: file.type, sizeBytes: file.size },
          });

          if (signal.aborted) throw new AbortError();

          if (res.status === "error") {
            updateItem(itemId, { status: "error", error: res.message });
            return;
          }

          ({ sessionId, totalParts, partSize, parts } = res.data!);
          updateItem(itemId, { sessionId, strategy: "multipart" });
        }

        const completedParts: { partNumber: number; etag: string }[] = parts
          .filter((p) => p.uploadedAt && p.etag)
          .map((p) => ({ partNumber: p.partNumber, etag: p.etag! }));

        const pendingParts = parts.filter((p) => !p.uploadedAt);

        for (let i = 0; i < pendingParts.length; i += MAX_PARALLEL_PARTS) {
          if (signal.aborted) throw new AbortError();

          const batch = pendingParts.slice(i, i + MAX_PARALLEL_PARTS);

          const results = await Promise.allSettled(
            batch.map(async (part) => {
              const start = (part.partNumber - 1) * partSize;
              const end = Math.min(start + partSize, file.size);
              const chunk = file.slice(start, end);

              const etag = await putWithRetry(part.uploadUrl, chunk, signal, (delta) => onDelta(itemId, delta));

              if (signal.aborted) throw new AbortError();

              await post({
                path: `/upload/multipart/${sessionId}/parts`,
                body: { partNumber: part.partNumber, etag, sizeBytes: chunk.size },
              });

              completedParts.push({ partNumber: part.partNumber, etag });
            }),
          );

          const failures = results
            .map((r, idx) => ({ r, part: batch[idx]! }))
            .filter((x): x is { r: PromiseRejectedResult; part: PartInfo } => x.r.status === "rejected");

          if (failures.length > 0) {
            // Propagate AbortError immediately if any failure was an abort
            const abortFailure = failures.find((x) => isAbortError(x.r.reason));
            if (abortFailure) throw new AbortError();

            const detail = failures
              .map(
                ({ r, part }) =>
                  `part ${part.partNumber}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
              )
              .join("; ");

            throw new Error(`Multipart upload failed (${detail})`);
          }
        }

        if (signal.aborted) throw new AbortError();

        updateItem(itemId, { status: "completing", progress: 99 });

        const completeRes = await post({
          path: `/upload/multipart/${sessionId}/complete`,
          body: { parts: completedParts },
        });

        if (signal.aborted) throw new AbortError();

        if (completeRes.status === "error") {
          updateItem(itemId, { status: "error", error: completeRes.message });
          return;
        }

        updateItem(itemId, { status: "done", progress: 100, timeRemaining: null });
      } catch (err) {
        if (isAbortError(err)) {
          updateItem(itemId, { status: "aborted", error: null });
          // Clean up the R2 multipart session after confirming the upload
          // has actually stopped (we're inside the catch, so all XHRs have
          // either completed or been aborted by the signal).
          if (sessionId) {
            del({ path: `/upload/multipart/${sessionId}` }).catch(() => {});
          }
        } else {
          updateItem(itemId, { status: "error", error: err instanceof Error ? err.message : "Upload failed" });
        }
      } finally {
        cleanupItem(itemId);
      }
    },
    [updateItem, onDelta, cleanupItem],
  );

  // ─── Public API ───────────────────────────────────────────────────────────
  const upload = useCallback(
    (file: File, folderId: string): string => {
      const id = crypto.randomUUID();
      const isMultipart = file.size > SIMPLE_THRESHOLD;
      const controller = new AbortController();

      setItems((prev) => [
        ...prev,
        {
          id,
          file,
          folderId,
          status: "uploading",
          progress: 0,
          uploadedBytes: 0,
          totalBytes: file.size,
          speed: 0,
          timeRemaining: null,
          error: null,
          strategy: isMultipart ? "multipart" : "simple",
        },
      ]);

      speedTrackers.current.set(id, { bytes: 0, ts: Date.now() });
      abortControllers.current.set(id, controller);

      if (isMultipart) {
        multipartUpload(id, file, folderId, controller.signal);
      } else {
        simpleUpload(id, file, folderId, controller.signal);
      }

      return id;
    },
    [simpleUpload, multipartUpload],
  );

  const uploads = useCallback(
    (files: FileList | File[], folderId: string) => {
      Array.from(files).forEach((f) => upload(f, folderId));
    },
    [upload],
  );

  const abortUpload = useCallback((itemId: string) => {
    // Signal the abort — the upload coroutine's catch block is the single
    // source of truth for status updates and backend cleanup.
    abortControllers.current.get(itemId)?.abort();
  }, []);

  const dismissItem = useCallback(
    (itemId: string) => {
      setItems((prev) => prev.filter((i) => i.id !== itemId));
      cleanupItem(itemId);
    },
    [cleanupItem],
  );

  const dismissAll = useCallback(() => {
    setItems((prev) => prev.filter((i) => i.status === "uploading" || i.status === "completing"));
  }, []);

  const loadPendingSessions = useCallback(async () => {
    const res = await get<PendingSession[]>({ path: "/upload/multipart/sessions" });
    if (res.status === "success") setPendingSessions(res.data);
  }, []);

  const resumeSession = useCallback(
    (session: PendingSession, file: File) => {
      const id = crypto.randomUUID();
      const controller = new AbortController();

      setItems((prev) => [
        ...prev,
        {
          id,
          file,
          folderId: "",
          status: "uploading",
          progress: session.percentComplete,
          uploadedBytes: session.uploadedBytes,
          totalBytes: session.sizeBytes,
          speed: 0,
          timeRemaining: null,
          error: null,
          sessionId: session.sessionId,
          strategy: "multipart",
        },
      ]);

      speedTrackers.current.set(id, { bytes: 0, ts: Date.now() });
      abortControllers.current.set(id, controller);
      setPendingSessions((prev) => prev.filter((s) => s.sessionId !== session.sessionId));

      multipartUpload(id, file, null, controller.signal, session.sessionId);
    },
    [multipartUpload],
  );

  const activeCount = items.filter((i) => i.status === "uploading" || i.status === "completing").length;
  const hasFinished = items.some((i) => i.status === "done" || i.status === "error" || i.status === "aborted");

  return {
    items,
    pendingSessions,
    activeCount,
    hasFinished,
    upload,
    uploads,
    abortUpload,
    dismissItem,
    dismissAll,
    loadPendingSessions,
    resumeSession,
  };
}
