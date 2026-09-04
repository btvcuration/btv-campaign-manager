// 🌟 [신규] description 안의 mermaid 코드 블록(```...```)을 찾아냄
const MERMAID_BLOCK_REGEX = /```(?:mermaid)?\s*\n?(graph\s[\s\S]*?)```/;
function extractMermaidBlock(desc) {
  if (!desc) return null;
  const match = desc.match(MERMAID_BLOCK_REGEX);
  if (!match) return null;
  return { fullMatch: match[0], code: match[1].trim() };
}

// 🌟 [신규] mermaid.ink로 mermaid 코드 → PNG Blob 변환 (한글 포함 UTF-8 안전 처리)
async function mermaidToPngBlob(mermaidCode) {
  const utf8Bytes = new TextEncoder().encode(mermaidCode);
  let binary = '';
  utf8Bytes.forEach(b => { binary += String.fromCharCode(b); });
  const base64 = btoa(binary);
  const url = `https://mermaid.ink/img/${encodeURIComponent(base64)}?type=png&bgColor=white`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`mermaid.ink 렌더링 실패 (HTTP ${res.status})`);
  return await res.blob();
}

const CF_WORKER_URL = "https://btv-proxy.alcheminos.workers.dev";
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, maxRetries = 3) {
  let baseDelay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      await sleep(retryAfter ? parseInt(retryAfter) * 1000 : baseDelay);
      baseDelay *= 2; continue;
    }
    if (response.status === 401) throw new Error(`[401 Unauthorized] Jira 세션이 만료되었습니다. 다시 로그인해주세요.`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`[HTTP ${response.status}] 서버 에러 발생!\n응답 내용: ${errorText.substring(0, 200)}...`);
    }
    return response;
  }
  throw new Error("서버 응답 지연으로 최대 재시도 횟수를 초과했습니다.");
}

function dataURLtoBlob(dataurl) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1], bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while(n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new Blob([u8arr], { type: mime });
}

const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '';

chrome.action.onClicked.addListener((tab) => chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" }));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'fetchCapaCsv') {
    fetch('https://btv-proxy.alcheminos.workers.dev/?action=getCapaCsv')
      .then(res => res.text()).then(csvText => sendResponse({ success: true, data: csvText }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
  if (message.action === "OPEN_JIRA_TEST") {
    createJiraHierarchy(message.data, sender.tab.id);
    sendResponse({ status: "processing" });
    return true;
  }
  if (message.action === "TAKE_SCREENSHOT") {
    const targetWindowId = sender.tab ? sender.tab.windowId : null;
    chrome.tabs.captureVisibleTab(targetWindowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) sendResponse({ dataUrl: null });
      else sendResponse({ dataUrl: dataUrl });
    });
    return true;
  }
  if (message.action === "CHECK_JIRA_SESSION") {
    fetch("https://jira.skbroadband.com/rest/api/2/myself", { credentials: "include" })
      .then(res => sendResponse({ isLogged: res.ok && !res.headers.get("content-type")?.includes("text/html") }))
      .catch(e => sendResponse({ isLogged: false }));
    return true;
  }
});

async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const MERMAID_PLACEHOLDER = "___MERMAID_DIAGRAM_PLACEHOLDER___";
  const mermaidBlock = extractMermaidBlock(data.parent.desc);
  if (mermaidBlock) {
    data.parent.desc = data.parent.desc.replace(mermaidBlock.fullMatch, MERMAID_PLACEHOLDER);
  }
  const projectKey = "BTVMKT";
  const targetUserId = data.parent?.assignee || "system";
  const PARENT_ISSUE_TYPE = "Task", CHILD_ISSUE_TYPE = "Sub-Task";
  const START_DATE_FIELD = "customfield_10134", FINISH_DATE_FIELD = "customfield_10135";
  let parentKey = data.parentJiraKey || "";
  let createdIssues = [];

  try {
    // 🌟 1단계: Jira 이슈 껍데기(텍스트) 먼저 모두 생성
    if (!data.skipJira) {
      const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));
      const safeInitialDesc = data.parent.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
      const parentFields = {
        project: { key: projectKey }, summary: data.parent.title, description: safeInitialDesc,
        issuetype: { name: PARENT_ISSUE_TYPE }, reporter: { name: targetUserId }, assignee: { name: targetUserId }, labels: uniqueLabels
      };
      if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
      if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

      if (parentKey) {
        const updateFields = { ...parentFields }; delete updateFields.project; delete updateFields.issuetype;
        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: updateFields }) });
        const pRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'GET', headers: { 'Content-Type': 'application/json' }, credentials: 'include' });
        const pData = await pRes.json();
        const existingSubtasks = pData.fields?.subtasks || [];
        
        for (let i = 0; i < data.children.length; i++) {
          const childData = data.children[i];
          const safeChildDesc = childData.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
          const childFields = {
            project: { key: projectKey }, summary: childData.title, description: safeChildDesc,
            issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey },
            reporter: { name: targetUserId }, assignee: { name: childData.assignee || targetUserId }, labels: childData.gnb.map(formatLabel)
          };
          if (childData.startDate) childFields[START_DATE_FIELD] = childData.startDate;
          if (childData.dueDate) childFields[FINISH_DATE_FIELD] = childData.dueDate;
          
          if (i < existingSubtasks.length) {
            const subKey = existingSubtasks[i].key;
            const cUpdateFields = { ...childFields }; delete cUpdateFields.project; delete cUpdateFields.issuetype; delete cUpdateFields.parent;
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${subKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: cUpdateFields }) });
            createdIssues.push({ key: subKey });
          } else {
            const cRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: childFields }) });
            createdIssues.push({ key: (await cRes.json()).key });
          }
        }
      } else {
        const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: parentFields }) });
        parentKey = (await parentRes.json()).key;
        await sleep(300);

        const childUpdates = data.children.map(child => {
          const safeChildDesc = child.desc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, "UPLOADING_IMAGE_WAIT...");
          const fieldData = { project: { key: projectKey }, summary: child.title, description: safeChildDesc, issuetype: { name: CHILD_ISSUE_TYPE }, parent: { key: parentKey }, reporter: { name: targetUserId }, assignee: { name: child.assignee || targetUserId }, labels: child.gnb.map(formatLabel) };
          if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
          if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;
          return { fields: fieldData };
        });
        const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ issueUpdates: childUpdates }) });
        createdIssues = (await childBulkRes.json()).issues;
      }
    }

    // 🌟 2단계: DB(구글 시트) 동기화를 첨부파일 업로드보다 먼저 실행!!
    if (data.rawGasData) {
      const { meta, assignee, assets } = data.rawGasData;
      const uniqueCode = data.uniqueCode || meta.uniqueCode;
      const safeTargetSize = parseInt(String(meta.targetSize).replace(/[^0-9]/g, '')) || 0;
      
      let bulkPayload = [];
      bulkPayload.push({
        jiraLink: parentKey ? `${baseUrl}/browse/${parentKey}` : "", uniqueCode: uniqueCode, campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'MASS', channel: '-', hasBanner: assets.length > 0 ? 'Y' : 'N', taskType: data.skipJira ? '-' : '-', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: safeTargetSize, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: meta.conceptCopy || '-', landingUrl: '', designLink: meta.mainImageUrl || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
        assets: assets, mermaidCode: data.rawGasData.mermaidCode || "", meta: meta
      });
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i]; const assetData = asset.data || {};
        const childJiraUrl = createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : '';
        let textParts = [];
        if (assetData.topText) textParts.push(assetData.topText); if (assetData.mainTitle) textParts.push(assetData.mainTitle); if (assetData.bannerCopy) textParts.push(assetData.bannerCopy); if (assetData.subTitle) textParts.push(assetData.subTitle);
        bulkPayload.push({
          jiraLink: childJiraUrl, uniqueCode: uniqueCode, campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'MASS', channel: Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '-'), hasBanner: asset.type && (asset.type.includes("BANNER") || asset.type.includes("TODAY")) ? "Y" : "N", taskType: asset.type || '-', startDate: assetData.startDate || meta.startDate || '', endDate: assetData.dueDate || meta.dueDate || '', assignee: assignee || '', targetSize: 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: textParts.length > 0 ? textParts.join(' / ') : '-', landingUrl: assetData.landingValue || '', designLink: assetData.imageUrl || assetData.bgImg || assetData.bannerImg || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }
      if (meta.target === 'TARGET') {
        const bannerTypes = assets.length > 0 ? assets.map(a => a.name).join(', ') : '-';
        bulkPayload.push({
          jiraLink: "", uniqueCode: uniqueCode, campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'TARGET', channel: '-', hasBanner: 'N', taskType: 'TARGET_OPERATION', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: safeTargetSize, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: `타겟 배정(${bannerTypes})`, landingUrl: '', designLink: '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }
      
      if (bulkPayload.length > 0) {
        try {
          const dbRes = await fetch(CF_WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "bulkInsert", rows: bulkPayload }) });
          const dbText = await dbRes.text();
          let dbJson;
          try { dbJson = JSON.parse(dbText); } catch(e) {}
          
          if (!dbJson || dbJson.status !== "success") {
            // 🌟 [핵심] 실패하더라도 스크립트를 죽이지(throw) 않고 화면에 팝업만 띄웁니다!
            if (sourceTabId) {
              chrome.scripting.executeScript({ 
                target: { tabId: sourceTabId }, 
                func: (msg) => alert("🚨 [구글 시트 저장 실패] 에러 상세 정보:\n" + msg), 
                args: [dbJson ? dbJson.message : dbText.substring(0, 150)] 
              }).catch(e=>e);
            }
          }
        } catch (dbErr) {
          if (sourceTabId) {
            chrome.scripting.executeScript({ 
              target: { tabId: sourceTabId }, 
              func: (msg) => alert("🚨 [구글 시트 통신 실패]\n" + msg), 
              args: [dbErr.message] 
            }).catch(e=>e);
          }
        }
      }
    }

    // 🌟 3단계: 성공했으니 사용자에게 Jira 창을 먼저 열어줌 (백그라운드에서 첨부파일이 올라가는 동안 사용자는 창을 볼 수 있음)
    if (!data.skipJira && parentKey) {
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    }

    // 🌟 4단계: (가장 오래 걸리는 작업) 첨부파일 업로드 및 텍스트(URL) 치환
    if (!data.skipJira) {
      let uploadedParentAttachments = [];
      if (data.parent.images && data.parent.images.length > 0) {
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            const formData = new FormData(); formData.append("file", dataURLtoBlob(imgObj.dataUrl), imgObj.filename);
            const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
            const attJson = await attachRes.json();
            uploadedParentAttachments.push(...attJson);
          }
        }
      }
      // 🌟 [신규] mermaid 다이어그램 이미지 변환 + 첨부
      let mermaidAttachment = null;
      if (mermaidBlock) {
        try {
          const pngBlob = await mermaidToPngBlob(mermaidBlock.code);
          const mermaidFormData = new FormData();
          mermaidFormData.append("file", pngBlob, `user_flow_${Date.now()}.png`);
          const mermaidAttachRes = await fetchWithRetry(
            `${baseUrl}/rest/api/2/issue/${parentKey}/attachments`,
            { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: mermaidFormData }
          );
          const mermaidAttJson = await mermaidAttachRes.json();
          if (mermaidAttJson && mermaidAttJson.length > 0) mermaidAttachment = mermaidAttJson[0];
        } catch (mermaidErr) {
          if (sourceTabId) {
            chrome.scripting.executeScript({
              target: { tabId: sourceTabId },
              func: (m) => alert("🚨 유저플로우 다이어그램 변환/첨부 실패:\n" + m),
              args: [mermaidErr.message]
            }).catch(e => e);
          }
        }
      }
    
      if (uploadedParentAttachments.length > 0 || mermaidAttachment) {
        let finalParentDesc = data.parent.desc;
        uploadedParentAttachments.forEach(att => {
          finalParentDesc = finalParentDesc.split(`PLACEHOLDER_${att.filename}`).join(att.content);
        });
        if (uploadedParentAttachments.length > 0) {
          finalParentDesc = finalParentDesc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedParentAttachments[0].content);
        }
        if (mermaidAttachment) {
          finalParentDesc = finalParentDesc.split(MERMAID_PLACEHOLDER).join(`!${mermaidAttachment.filename}|width=760!`);
        }
        await fetchWithRetry(
          `${baseUrl}/rest/api/2/issue/${parentKey}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalParentDesc } }) }
        );
      }

      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues[i]) continue;
        const issueKey = createdIssues[i].key;

        if (childData.imageData) {
          const formData = new FormData(); formData.append("file", dataURLtoBlob(childData.imageData), "preview.png");
          const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
          const uploadedChildAtt = await attachRes.json();
          if (uploadedChildAtt && uploadedChildAtt.length > 0) {
            let finalChildDesc = childData.desc.split(`PLACEHOLDER_preview.png`).join(uploadedChildAtt[0].content).replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedChildAtt[0].content);
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalChildDesc } }) });
          }
        }
      }
    }
  } catch (error) {
    if (sourceTabId) chrome.scripting.executeScript({ target: { tabId: sourceTabId }, func: (errMsg) => alert("🚨 Jira 전송 에러 상세 정보:\n\n" + errMsg), args: [error.message] }).catch(e=>e);
  }
}
