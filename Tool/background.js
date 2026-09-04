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
    
    if (response.status === 401) {
      throw new Error(`[401 Unauthorized] Jira 세션이 만료되었습니다. 다시 로그인해주세요.`);
    }

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
      if (chrome.runtime.lastError) {
        console.error("캡처 에러:", chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl: dataUrl });
      }
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
  const projectKey = "BTVMKT";
  const targetUserId = data.parent?.assignee || "system";
  const PARENT_ISSUE_TYPE = "Task", CHILD_ISSUE_TYPE = "Sub-Task";
  const START_DATE_FIELD = "customfield_10134", FINISH_DATE_FIELD = "customfield_10135";
  let parentKey = data.parentJiraKey || "";
  let createdIssues = [];

  try {
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
        console.log(`부모 이슈(${parentKey}) 업데이트 중...`);
        const updateFields = { ...parentFields };
        delete updateFields.project; delete updateFields.issuetype;
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
            const cUpdateFields = { ...childFields };
            delete cUpdateFields.project; delete cUpdateFields.issuetype; delete cUpdateFields.parent;
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${subKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: cUpdateFields }) });
            createdIssues.push({ key: subKey });
          } else {
            const cRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: childFields }) });
            createdIssues.push({ key: (await cRes.json()).key });
          }
        }
      } else {
        console.log("부모 이슈 생성 중...");
        const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: parentFields }) });
        parentKey = (await parentRes.json()).key;
        
        // 🌟 타임아웃 방지: 1초 대기를 300ms로 대폭 단축
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

      // 🌟 부모 첨부파일 초고속 업로드 (Sleep 완전 제거)
      let uploadedParentAttachments = [];
      if (data.parent.images && data.parent.images.length > 0) {
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            const formData = new FormData(); formData.append("file", dataURLtoBlob(imgObj.dataUrl), imgObj.filename);
            const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
            const attText = await attachRes.text();
            let attJson;
            try { attJson = JSON.parse(attText); } catch(e) { throw new Error(`[부모 첨부 파싱 에러] ${attText.substring(0, 150)}`); }
            uploadedParentAttachments.push(...attJson);
          }
        }
      }
      
      if (uploadedParentAttachments.length > 0) {
        let finalParentDesc = data.parent.desc; 
        uploadedParentAttachments.forEach(att => {
          const placeholder = `PLACEHOLDER_${att.filename}`;
          finalParentDesc = finalParentDesc.split(placeholder).join(att.content);
        });
        finalParentDesc = finalParentDesc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedParentAttachments[0].content);
        await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalParentDesc } }) });
      }

      if (data.parent.comment) {
        try { await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ body: data.parent.comment }) }); } catch(e){}
      }

      // 🌟 타임아웃 방지: 자식 이슈 인덱싱 대기 시간을 2.5초에서 1초로 단축
      await sleep(1000);

      // 🌟 자식 이슈 첨부파일 초고속 업로드 (Sleep 완전 제거)
      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues[i]) continue;
        const issueKey = createdIssues[i].key;

        if (childData.imageData) {
          const formData = new FormData(); formData.append("file", dataURLtoBlob(childData.imageData), "preview.png");
          const attachRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, { method: 'POST', headers: { 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: formData });
          
          const attText = await attachRes.text();
          let uploadedChildAtt;
          try { uploadedChildAtt = JSON.parse(attText); } catch(e) { throw new Error(`[자식 첨부 파싱 에러 - ${issueKey}] ${attText.substring(0, 150)}`); }

          if (uploadedChildAtt && uploadedChildAtt.length > 0) {
            let finalChildDesc = childData.desc;
            const placeholder = `PLACEHOLDER_preview.png`;
            finalChildDesc = finalChildDesc.split(placeholder).join(uploadedChildAtt[0].content);
            finalChildDesc = finalChildDesc.replace(/data:image\/[a-zA-Z0-9+;/=]+/g, uploadedChildAtt[0].content);
            
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ fields: { description: finalChildDesc } }) });
          }
        }

        if (childData.assignee) {
          try { await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/comment`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' }, credentials: 'include', body: JSON.stringify({ body: `담당자님 [~${childData.assignee}] 할당되었습니다.` }) }); } catch(e){}
        }
      }
    }
    
    // DB 동기화 로직
    if (data.rawGasData) {
      const { meta, assignee, assets } = data.rawGasData;
      const uniqueCode = data.uniqueCode || meta.uniqueCode;
      let bulkPayload = [];
      bulkPayload.push({
        jiraLink: parentKey ? `${baseUrl}/browse/${parentKey}` : "", 
        uniqueCode: uniqueCode, 
        campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'MASS', channel: '-', hasBanner: assets.length > 0 ? 'Y' : 'N', taskType: data.skipJira ? '-' : '-', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: parseInt(meta.targetSize) || 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: meta.conceptCopy || '-', landingUrl: '', designLink: meta.mainImageUrl || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
        assets: assets, mermaidCode: data.rawGasData.mermaidCode || "", meta: meta
      });
      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i]; const assetData = asset.data || {};
        const childJiraUrl = createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : '';
        let textParts = [];
        if (assetData.topText) textParts.push(assetData.topText); if (assetData.mainTitle) textParts.push(assetData.mainTitle); if (assetData.bannerCopy) textParts.push(assetData.bannerCopy); if (assetData.subTitle) textParts.push(assetData.subTitle);
        
        bulkPayload.push({
          jiraLink: childJiraUrl,
          uniqueCode: uniqueCode, 
          campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'MASS', channel: Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '-'), hasBanner: asset.type && (asset.type.includes("BANNER") || asset.type.includes("TODAY")) ? "Y" : "N", taskType: asset.type || '-', startDate: assetData.startDate || meta.startDate || '', endDate: assetData.dueDate || meta.dueDate || '', assignee: assignee || '', targetSize: 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: textParts.length > 0 ? textParts.join(' / ') : '-', landingUrl: assetData.landingValue || '', designLink: assetData.imageUrl || assetData.bgImg || assetData.bannerImg || '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }
      if (meta.target === 'TARGET') {
        const bannerTypes = assets.length > 0 ? assets.map(a => a.name).join(', ') : '-';
        bulkPayload.push({
          jiraLink: "", 
          uniqueCode: uniqueCode,
          campaignName: meta.campaignName || '-', product: meta.product || '', targetType: meta.target || 'TARGET', channel: '-', hasBanner: 'N', taskType: 'TARGET_OPERATION', startDate: meta.startDate || '', endDate: meta.dueDate || '', assignee: assignee || '', targetSize: parseInt(meta.targetSize) || 0, targetCondition: meta.targetCondition || '', notiChannel: '', mainCopy: `타겟 배정(${bannerTypes})`, landingUrl: '', designLink: '', hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N'
        });
      }
      if (bulkPayload.length > 0) {
        await fetch(CF_WORKER_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: "bulkInsert", rows: bulkPayload }) });
      }
    }
    if (!data.skipJira && parentKey) {
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    }
  } catch (error) {
    if (sourceTabId) chrome.scripting.executeScript({ target: { tabId: sourceTabId }, func: (errMsg) => alert("🚨 Jira 전송 에러 상세 정보:\n\n" + errMsg), args: [error.message] }).catch(e=>e);
  }
}
