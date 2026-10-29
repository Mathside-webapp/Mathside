/* Mathside R2 student submission bridge.
 * R2 stores bytes; existing Supabase submission RPC stores compatible references.
 * Do not place R2 credentials or raw object URLs in browser source.
 */
(() => {
  'use strict';
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const storageRefPattern = new RegExp(`^(${uuid})/(${uuid})/r2-(${uuid})\\.(jpg|png|webp)$`, 'i');
  const objectKeyPattern = new RegExp(`^assignments/(${uuid})/(${uuid})/(${uuid})\\.(jpg|png|webp)$`, 'i');

  async function invoke(client, name, body) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      let message = error.message || `Could not contact ${name}.`;
      try {
        if (error.context instanceof Response) {
          const responseBody = await error.context.clone().json();
          message = responseBody?.error || message;
        }
      } catch (_) {}
      throw new Error(message);
    }
    if (data?.error) throw new Error(data.error);
    return data || {};
  }

  function isR2ProofPath(path) {
    return storageRefPattern.test(String(path || ''));
  }

  async function uploadProof(client, { assignmentId, userId, file }) {
    if (!client || !file || !assignmentId || !userId) throw new Error('Missing upload information.');
    const contentType = file.type;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new Error('Please choose a JPG, PNG, or WebP solution picture.');
    }

    const signed = await invoke(client, 'r2-upload-url', {
      assignmentId,
      fileName: file.name,
      contentType,
      sizeBytes: file.size
    });
    if (!signed.uploadUrl || !signed.objectKey) throw new Error('Cloudflare upload permission was not returned.');
    const parts = objectKeyPattern.exec(signed.objectKey);
    if (!parts || parts[1].toLowerCase() !== String(assignmentId).toLowerCase() ||
        parts[2].toLowerCase() !== String(userId).toLowerCase()) {
      throw new Error('Cloudflare returned an unexpected upload destination.');
    }
    const response = await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file
    });
    if (!response.ok) throw new Error(`Cloudflare image upload failed (HTTP ${response.status}).`);

    // This reference satisfies Mathside's existing SQL validation:
    //   <student ID>/<assignment ID>/<filename>
    // The r2- prefix distinguishes it from older Supabase Storage paths.
    const proofPath = `${userId}/${assignmentId}/r2-${parts[3]}.${parts[4]}`;
    await invoke(client, 'r2-files', {
      action: 'confirm', proofPath, originalName: file.name
    });
    return proofPath;
  }

  async function signedProofUrl(client, proofPath) {
    if (!isR2ProofPath(proofPath)) return '';
    const result = await invoke(client, 'r2-files', { action: 'read', proofPath });
    if (!result.url || !/^https:\/\//i.test(result.url)) throw new Error('Could not open this Cloudflare file.');
    return result.url;
  }

  // Teacher-owned attachment references. All bytes live in private Cloudflare R2.
  // The server validates ownership and confirms the uploaded object before saving metadata.
  const teacherObjectKey = new RegExp(`^assignments/(${uuid})/(${uuid})/(${uuid})\\.(jpg|png|webp|pdf|docx|pptx|xlsx)$`, 'i');
  // Use a prefix to distinguish new R2 references from historical Supabase paths.
  const teacherPrefix = 'r2-teacher:';
  const teacherMime = new Set([
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]);
  function isR2TeacherPath(path) {
    return typeof path === 'string' && path.startsWith(teacherPrefix) &&
      teacherObjectKey.test(path.slice(teacherPrefix.length));
  }

  async function uploadTeacherFile(client, { assignmentId, userId, file }) {
    if (!client || !assignmentId || !userId || !file) throw new Error('Missing activity attachment information.');
    if (!teacherMime.has(file.type)) throw new Error('This attachment type is not supported. Use JPG, PNG, WebP, PDF, DOCX, PPTX or XLSX.');
    const signed = await invoke(client, 'r2-upload-url', {
      assignmentId, fileName: file.name, contentType: file.type, sizeBytes: file.size
    });
    const match = teacherObjectKey.exec(signed.objectKey || '');
    if (!signed.uploadUrl || !match ||
        match[1].toLowerCase() !== String(assignmentId).toLowerCase() ||
        match[2].toLowerCase() !== String(userId).toLowerCase()) {
      throw new Error('Cloudflare returned an unexpected teacher attachment destination.');
    }
    const uploadResponse = await fetch(signed.uploadUrl, {
      method: 'PUT', headers: {'Content-Type': file.type}, body: file
    });
    if (!uploadResponse.ok) throw new Error(`Cloudflare attachment upload failed (HTTP ${uploadResponse.status}).`);
    const ref = teacherPrefix + signed.objectKey;
    await invoke(client, 'r2-teacher-files', { action: 'confirm', ref, originalName: file.name });
    return ref;
  }

  async function signedTeacherUrl(client, ref) {
    if (!isR2TeacherPath(ref)) return '';
    const result = await invoke(client, 'r2-teacher-files', { action: 'read', ref });
    if (!result.url || !/^https:\/\//i.test(result.url)) throw new Error('Could not open the Cloudflare attachment.');
    return result.url;
  }

  window.MathsideR2 = Object.freeze({
    isR2ProofPath, uploadProof, signedProofUrl,
    isR2TeacherPath, uploadTeacherFile, signedTeacherUrl
  });
})();
