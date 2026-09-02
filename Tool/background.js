// 🚨 여기에 클라우드플레어에서 발급받은 워커 주소를 입력하세요!
const CF_WORKER_URL = "https://btv-proxy.alcheminos.workers.dev";

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, maxRetries = 5) {
  let baseDelay = 3000;
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url, options);
    
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      let waitTime = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay;
      console.warn(`[429 차단] ${waitTime/1000}초 대기 중...`);
      await sleep(waitTime);
      baseDelay *= 2;
      continue;
    }
    
    if (response.status === 401 || response.status === 403) {
      throw new Error(`인증 실패(${response.status}). 사내 Jira 페이지에 로그인되어 있는지 확인해 주세요.`);
    }

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
      throw new Error("Jira 로그인 세션이 만료되었습니다.\n\n새 탭을 열어 사내 Jira에 접속해 로그인하신 후, 다시 전송 버튼을 눌러주세요.");
    }

    if (!response.ok) {
      const errorText = await response.text();
      
      // 🌟 400 에러 맞춤형 안내 로직 복구
      if (response.status === 400) {
        throw new Error(
          `Jira 요청 실패 (상태코드: 400)\n\n` +
          `주로 다음 두 가지 원인으로 발생합니다:\n` +
          `1. 사내 Jira 로그인이 풀려있는 경우 (새 탭에서 Jira 로그인 확인)\n` +
          `2. 설정 화면에 입력한 '기본 담당자 Jira ID'가 올바르지 않은 경우\n\n` +
          `[상세 원인]: ${errorText}`
        );
      }

      throw new Error(`상태코드: ${response.status}\n상세이유: ${errorText}`);
    }
    
    return response;
  }
  throw new Error("서버 응답 지연. 잠시 후 다시 시도해주세요.");
}

function dataURLtoBlob(dataurl) {
  let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1],
      bstr = atob(arr[1]), n = bstr.length, u8arr = new Uint8Array(n);
  while(n--) { u8arr[n] = bstr.charCodeAt(n); }
  return new Blob([u8arr], { type: mime });
}

const formatLabel = (str) => str ? str.replace(/\s+/g, '_') : '미지정';

chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.create({ url: "https://btvcuration.github.io/campaign/" });
});

// 🌟 [추가됨] Jira 로그인 상태를 몰래 찔러보고(Fetch) 결과를 반환
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "CHECK_JIRA_SESSION") {
    fetch("https://jira.skbroadband.com/rest/api/2/myself", { credentials: "include" })
      .then(res => {
        const isHtml = res.headers.get("content-type")?.includes("text/html");
        // HTML 로그인 페이지로 리다이렉트되지 않고 정상 JSON 응답이 오면 로그인 상태임
        if (res.ok && !isHtml) sendResponse({ isLogged: true });
        else sendResponse({ isLogged: false });
      })
      .catch(e => sendResponse({ isLogged: false }));
    return true; // 비동기 응답 대기
  }
  
  if (request.action === 'fetchCapaCsv') {
    const CSV_URL = 'https://btv-proxy.alcheminos.workers.dev/?action=getCapaCsv';
    
    fetch(CSV_URL)
      .then(response => response.text())
      .then(csvText => {
        sendResponse({ success: true, data: csvText });
      })
      .catch(error => {
        console.error("Capa Fetch 에러:", error);
        sendResponse({ success: false, error: error.message });
      });
      
    return true; 
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "OPEN_JIRA_TEST") {
    createJiraHierarchy(message.data, sender.tab.id);
    sendResponse({ status: "processing" });
  } 
  
  else if (message.action === "TAKE_SCREENSHOT") {
    chrome.tabs.captureVisibleTab(null, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error("캡처 에러:", chrome.runtime.lastError.message);
        sendResponse({ dataUrl: null });
      } else {
        sendResponse({ dataUrl: dataUrl });
      }
    });
    return true; 
  }
});

// Jira API 호출 및 구글 시트(CF 우회) 계층구조 생성
async function createJiraHierarchy(data, sourceTabId) {
  const baseUrl = "https://jira.skbroadband.com";
  const projectKey = "BTVMKT"; 
  const targetUserId = data.parent.assignee;

  const PARENT_ISSUE_TYPE = "Task";    
  const CHILD_ISSUE_TYPE = "Sub-Task"; 

  const START_DATE_FIELD = "customfield_10134"; 
  const FINISH_DATE_FIELD = "customfield_10135";

  let parentKey = "";
  let createdIssues = [];

  try {
    // 🌟 [추가됨] Jira 패스 모드 분기 처리
    if (!data.skipJira) {
      const uniqueLabels = Array.from(new Set(data.children.flatMap(c => c.gnb.map(formatLabel))));

      // 1️⃣ 상위 일감 생성
      const parentFields = {
        project: { key: projectKey },
        summary: data.parent.title,
        description: data.parent.desc,
        issuetype: { name: PARENT_ISSUE_TYPE },
        reporter: { name: targetUserId },
        assignee: { name: targetUserId },
        labels: uniqueLabels
      };
      
      if (data.parent.startDate) parentFields[START_DATE_FIELD] = data.parent.startDate;
      if (data.parent.dueDate) parentFields[FINISH_DATE_FIELD] = data.parent.dueDate;

      console.log("🚀 부모 일감 생성 요청 중...");
      const parentRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
        credentials: 'include',
        body: JSON.stringify({ fields: parentFields })
      });
      
      const parentResult = await parentRes.json();
      parentKey = parentResult.key; 
      console.log("✅ 부모 일감 생성 완료:", parentKey);

      await sleep(1000); 

      if (data.parent.images && data.parent.images.length > 0) {
        console.log(`📸 부모 일감(${parentKey}) 이미지 첨부 시작 (${data.parent.images.length}장)`);
        for (const imgObj of data.parent.images) {
          if (imgObj.dataUrl) {
            const imageBlob = dataURLtoBlob(imgObj.dataUrl);
            const formData = new FormData();
            formData.append("file", imageBlob, imgObj.filename);

            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/attachments`, {
              method: 'POST',
              headers: { 'X-Atlassian-Token': 'no-check' }, 
              credentials: 'include',
              body: formData
            });
            console.log(`✅ 부모 첨부 완료: ${imgObj.filename}`);
            await sleep(500); 
          }
        }
      }
      
      // 담당자 멘션(Mention) 댓글 달기
      if (data.parent.comment) {
        console.log("💬 상위 일감 담당자 멘션 댓글 작성 시작...");
        try {
          await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${parentKey}/comment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
            credentials: 'include',
            body: JSON.stringify({ body: data.parent.comment })
          });
          console.log(`✅ 부모 댓글 작성 완료: ${parentKey}`);
          await sleep(500); 
        } catch (e) {
          console.error(`❌ 부모 댓글 에러: ${parentKey}`, e);
        }
      }

      // 2️⃣ 하위 일감 일괄(Bulk) 생성
      console.log("🚀 하위 일감 일괄 생성 요청 중...");
      const childUpdates = data.children.map(child => {
        const fieldData = {
          project: { key: projectKey },
          summary: child.title,
          description: child.desc, 
          issuetype: { name: CHILD_ISSUE_TYPE }, 
          parent: { key: parentKey },
          reporter: { name: targetUserId },
          assignee: { name: child.assignee || targetUserId },
          labels: child.gnb.map(formatLabel)
        };

        if (child.startDate) fieldData[START_DATE_FIELD] = child.startDate;
        if (child.dueDate) fieldData[FINISH_DATE_FIELD] = child.dueDate;

        return { fields: fieldData };
      });

      const childBulkRes = await fetchWithRetry(`${baseUrl}/rest/api/2/issue/bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
        credentials: 'include',
        body: JSON.stringify({ issueUpdates: childUpdates })
      });

      const childBulkResult = await childBulkRes.json();
      createdIssues = childBulkResult.issues;
      console.log("✅ 하위 일감 생성 완료");

      // 3️⃣ 캡처된 이미지를 하위 일감에 첨부
      console.log("📸 하위 일감 이미지 첨부 시작...");
      for (let i = 0; i < data.children.length; i++) {
        const childData = data.children[i];
        if (!createdIssues || !createdIssues[i]) continue;
        const issueKey = createdIssues[i].key; 

        if (childData.imageData) {
          const imageBlob = dataURLtoBlob(childData.imageData);
          const formData = new FormData();
          formData.append("file", imageBlob, "preview.png");

          await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/attachments`, {
            method: 'POST',
            headers: { 'X-Atlassian-Token': 'no-check' }, 
            credentials: 'include',
            body: formData
          });
          console.log(`✅ 하위 첨부 완료: ${issueKey}`);
          await sleep(1000); 
        }

        // 이미지 첨부 후 담당자 멘션(Mention) 댓글 자동 작성
        if (childData.assignee) {
          const commentBody = {
            body: `담당자 [~${childData.assignee}]님, 신규 캠페인 세팅 및 편성 확인 부탁드립니다.`
          };
          try {
            await fetchWithRetry(`${baseUrl}/rest/api/2/issue/${issueKey}/comment`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
              credentials: 'include',
              body: JSON.stringify(commentBody)
            });
            console.log(`✅ 멘션 댓글 작성 완료: ${issueKey}`);
            await sleep(500); 
          } catch (e) {
            console.error(`❌ 댓글 에러: ${issueKey}`, e);
          }
        }
      }
    } else {
      console.log("🚀 [Jira 패스 모드] Jira 일감 생성 없이 DB 저장만 수행합니다.");
    }

    // 🌟 4️⃣ Cloudflare Worker를 거쳐 Google Sheets에 데이터 적재
    if (data.rawGasData) {
      console.log("🚀 구글 시트(CF Proxy) DB 기록 시작...");
      const { meta, assignee, assets } = data.rawGasData;
      
      // 🌟 프론트엔드에서 전달받은 Unique Code 사용
      const uniqueCode = meta.uniqueCode || `BTV-${Date.now().toString(36).toUpperCase()}`;
      
      const sendToGAS = async (payload) => {
        try {
          const response = await fetch(CF_WORKER_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const result = await response.json();
          if (result.status !== "success") throw new Error(result.message);
        } catch (err) {
          console.error(`❌ 구글 시트 전송 에러:`, err);
        }
      };

      // Target 모수가 80만을 초과하면 자동으로 청크(Chunk) 분할
      const MAX_TARGET_SIZE = 800000;
      const totalSize = parseInt(meta.targetSize) || 0;
      const isTarget = meta.target === 'TARGET';
      
      let chunks = [];
      if (isTarget && totalSize > MAX_TARGET_SIZE) {
        let remaining = totalSize;
        while (remaining > 0) {
          chunks.push(Math.min(remaining, MAX_TARGET_SIZE));
          remaining -= MAX_TARGET_SIZE;
        }
      } else {
        chunks.push(totalSize); // 80만 이하면 1개로 처리
      }

      let bulkPayload = [];

      // 1. 가장 먼저 '모일감(Parent)' 전용 마스터 행 추가
      bulkPayload.push({
        parentJira: parentKey ? `${baseUrl}/browse/${parentKey}` : "", // 패스 모드일 땐 빈값
        uniqueCode: uniqueCode, // 🌟 자식 지라 URL 대신 유니크 코드 전송
        childJira: parentKey ? `${baseUrl}/browse/${parentKey}` : "", 
        campaignName: meta.campaignName || '신규 캠페인',
        product: meta.product || '',
        targetType: meta.target || 'MASS',
        channel: '캠페인 전체', 
        hasBanner: assets.length > 0 ? 'Y' : 'N',
        taskType: data.skipJira ? '쿠폰/사은품 단독' : '캠페인 모일감', // 🌟 Jira 패스 모드일 땐 라벨링 분리
        startDate: meta.startDate || '',
        endDate: meta.dueDate || '',
        assignee: assignee || '',
        targetSize: parseInt(meta.targetSize) || 0,
        targetCondition: meta.targetCondition || '',
        notiChannel: '',
        mainCopy: meta.conceptCopy || '캠페인 마스터',
        landingUrl: '',
        designLink: meta.mainImageUrl || '',
        hasCoupon: (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N',
        assets: assets,
        mermaidCode: data.rawGasData.mermaidCode || "",
        meta: meta
      });

      // 2. 자식 일감(배너 에셋) 추가
      for (let c = 0; c < chunks.length; c++) {
        const chunkSize = chunks[c];
        const suffix = chunks.length > 1 ? `_${c + 1}` : '';
        const currentCampaignName = (meta.campaignName || '') + suffix;

        for (let i = 0; i < assets.length; i++) {
          const asset = assets[i];
          const assetData = asset.data || {};
          const gnbStr = Array.isArray(assetData.gnb) ? assetData.gnb.join(', ') : (assetData.gnb || '미지정');
          const imgUrl = assetData.imageUrl || assetData.bgImg || assetData.bannerImg || assetData.previewImg || '';
          
          let textParts = [];
          if (assetData.topText) textParts.push(assetData.topText);
          if (assetData.mainTitle) textParts.push(assetData.mainTitle);
          if (assetData.copy) textParts.push(assetData.copy);
          if (assetData.bannerCopy) textParts.push(assetData.bannerCopy);
          if (assetData.previewTitle) textParts.push(assetData.previewTitle);
          if (assetData.topLogo) textParts.push(assetData.topLogo);
          if (assetData.subText) textParts.push(assetData.subText);
          if (assetData.subTitle) textParts.push(assetData.subTitle);
          if (assetData.buttonText) textParts.push(assetData.buttonText);
          if (assetData.badgeText) textParts.push(assetData.badgeText);
          
          const mainCopy = textParts.length > 0 ? textParts.join(' / ') : '카피 없음';
          const childJiraUrl = createdIssues && createdIssues[i] ? `${baseUrl}/browse/${createdIssues[i].key}` : '';
          const isBannerAsset = asset.type && (asset.type.includes("BANNER") || asset.type.includes("TODAY")) ? "Y" : "N";
          const safeHasCoupon = (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N';

          bulkPayload.push({
            parentJira: parentKey ? `${baseUrl}/browse/${parentKey}` : "",
            uniqueCode: uniqueCode, // 🌟 유니크 코드 전송
            childJira: childJiraUrl, 
            campaignName: currentCampaignName, 
            product: meta.product || '',
            targetType: meta.target || 'MASS',
            channel: gnbStr,
            hasBanner: isBannerAsset,
            taskType: asset.type || '기타',
            startDate: assetData.startDate || meta.startDate || '',
            endDate: assetData.dueDate || meta.dueDate || '',
            assignee: assignee || '',
            targetSize: 0, 
            targetCondition: meta.targetCondition || '',
            notiChannel: '',
            mainCopy: mainCopy,
            landingUrl: assetData.landingValue || '',
            designLink: imgUrl,
            hasCoupon: safeHasCoupon
          });
        }

        if (isTarget) {
          const bannerTypes = assets.length > 0 ? assets.map(a => a.name).join(', ') : '배너 없음 (타겟 전용)'; 
          const targetChildJiraUrl = createdIssues && createdIssues[assets.length] ? `${baseUrl}/browse/${createdIssues[assets.length].key}` : '';
          const safeHasCoupon = (meta.hasCoupon || '').trim().toUpperCase() === 'Y' ? 'Y' : 'N';

          bulkPayload.push({
            parentJira: parentKey ? `${baseUrl}/browse/${parentKey}` : "",
            uniqueCode: uniqueCode, // 🌟 유니크 코드 전송
            childJira: targetChildJiraUrl,
            campaignName: currentCampaignName,
            product: meta.product || '',
            targetType: meta.target || 'TARGET',
            channel: '기타',
            hasBanner: 'N',
            taskType: 'TARGET_OPERATION',
            startDate: meta.startDate || '',
            endDate: meta.dueDate || '',
            assignee: assignee || '',
            targetSize: chunkSize, 
            targetCondition: meta.targetCondition || '',
            notiChannel: '',
            mainCopy: `타겟팅 세팅 요청 (포함 배너: ${bannerTypes})`,
            landingUrl: '',
            designLink: '',
            hasCoupon: safeHasCoupon
          });
        }
      }

      if (bulkPayload.length > 0) {
        await sendToGAS({ action: "bulkInsert", rows: bulkPayload });
      }

      console.log("✅ 구글 시트(CF Proxy) DB 기록 완료");
    }

    // 🌟 전송 모드에 따른 처리 결과 (탭 오픈 여부)
    if (!data.skipJira && parentKey) {
      console.log("🎉 모든 작업 완료! 지라 창을 엽니다.");
      chrome.tabs.create({ url: `${baseUrl}/browse/${parentKey}` });
    } else if (data.skipJira) {
      console.log("🎉 DB 전용 저장 완료!");
    }

  } catch (error) {
    console.error("API 연동 에러:", error);
    if (sourceTabId) {
      chrome.scripting.executeScript({
        target: { tabId: sourceTabId },
        func: (errMsg) => alert("🚨 전송 에러!\n\n" + errMsg),
        args: [error.message]
      }).catch(e => console.error(e));
    }
  }
}
