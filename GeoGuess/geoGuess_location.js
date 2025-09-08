/* geoGuessr-style Korea Game (Kakao Maps) - Full JS (IE11 compatible)
 * Requirements:
 *  - Kakao Maps JS SDK with services:
 *    <script src="//dapi.kakao.com/v2/maps/sdk.js?appkey=YOUR_KEY&libraries=services"></script>
 *  - HTML IDs: roadview, map, round-info, score-info
 *  - regions.json : [{ "region":"서울특별시", "bbox":[minLat, minLng, maxLat, maxLng] }, ...]
 */


/* ===== Polyfills / Helpers ===== */
if (!Math.log10) {
  Math.log10 = function(x){ return Math.log(x) / Math.LN10; };
}

function addListenerOnce(target, type, handler) {
  // kakao.maps.event.addListenerOnce가 있지만 안전하게 래핑(wrapping)
  var called = false;
  return kakao.maps.event.addListener(target, type, function(){
    if (called) return;
    called = true;
    handler.apply(null, arguments);
  });
}

/* ===== Config ===== */
var GAME_MAX_ROUNDS = 5;
var SCORE_MAX = 5000;
var SCORE_DMAX = 100; // km: 100km 이상이면 0점
var INITIAL_MAP_CENTER = new kakao.maps.LatLng(36.5, 127.9);
var INITIAL_MAP_LEVEL = 13;
var REGIONS_URL = "./regions.json";

/* ===== State ===== */
var regions = [];
var roadview, roadviewClient, geocoder, map, mapMarker;
var round = 0;          // 0..GAME_MAX_ROUNDS-1
var score = 0;
var currentPlace = null; // {name,label,lat,lng}
var rvInitialized = false; // roadview init 여부
var pendingGuess = null;   // 사용자가 지도에 찍어둔 좌표
var roundLogs = [];   // {round, answer:{lat, lng, label}, guess:{lat,lng}, distKm, earned}
// 결과용 맵 상태
var resultMap = null;
var resultMarkers = [];
var resultPolyline = null;

/* ===== UI Helpers ===== */
function setText(id, txt){
  var el = document.getElementById(id);
  if (el) el.innerText = txt;
}
function updateHUD(){
  setText('round-info', '라운드: ' + (round + 1) + ' / ' + GAME_MAX_ROUNDS);
  setText('score-info', '현재 점수: ' + score);
}

/* ===== Distance & Score ===== */
function toRad(deg){ return deg * Math.PI / 180; }
function haversineKm(lat1, lng1, lat2, lng2){
  var R = 6371;
  var dLat = toRad(lat2 - lat1);
  var dLon = toRad(lng2 - lng1);
  var a = Math.pow(Math.sin(dLat/2),2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.pow(Math.sin(dLon/2),2);
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}
// 로그 기반 연속 점수 (100km 이상 0점)
function scoreFromDistance(distanceKm){
  if (distanceKm >= SCORE_DMAX) return 0;
  // 5000 × [ 1 − log10(d+1) / log10(101) ]
  var v = 1 - (Math.log10(distanceKm + 1) / Math.log10(SCORE_DMAX + 1));
  var s = SCORE_MAX * v;
  return Math.max(0, Math.round(s));
}

/* ===== Data Load ===== */
function loadRegions(callback){
  // XHR 객체 생성 후 GET 요청을 건다.
  var xhr = new XMLHttpRequest();
  // URL 뒤에 ?ts=<현재시각>을 붙여 캐시를 무력화(캐시 버스팅)한다. 
  // 개발 시 json이 갱신되는데 브라우저 캐시로 인해 안 바뀌는 문제를 방지한다.
  xhr.open('GET', REGIONS_URL + '?ts=' + (new Date().getTime()), true);

  // 요청 상태 변화를 감지한다.
  xhr.onreadystatechange = function(){
    if (xhr.readyState === 4) {   // 4는 서버 응답이 끝났음을 의미.
      if (xhr.status >= 200 && xhr.status < 300) {  // HTTP 성공(2XX) 일때만 파싱 시도.
        // 응답 텍스트를 json으로 파싱해서 regions에 저장
        try { regions = JSON.parse(xhr.responseText) || []; }
        catch(e){ alert('regions.json 파싱 실패'); return; }

        // 파싱까지 되면 전달받은 callback을 호출. 여기서 보통 startRound()로 이어짐
        if (typeof callback === 'function') callback();
      } else {
        // HTTP 실패(403, 404 등) 시 상태코드 alert
        alert('regions.json 로드 실패 (' + xhr.status + ')');
      }
    }
  };
  // 전송
  xhr.send(null);
}

/* 로드뷰가 해당 파노라마로 전환 완료된 뒤, 실제 파노라마의 좌표를 읽고
*  역 지오코딩으로 행정구역 라벨을 얻어 -> 그 결과를 callback에 넘긴다.
*/
function finalizeRoadviewReady(callback){
    // 위치 확정
    var realPos = roadview.getPosition();

    // 라벨 확정
    // 역지오 (좌표 -> 행정구역명)
    getRegionLabel(realPos, function(label){ // label 받아왔다
        // callback에 결과 전달
        callback({
            latlng: realPos,
            panoId: (roadview.getPanoId ? roadview.getPanoId(): null),
            label: label
        });
    });
    // 결과는 currentPlace = {name: label, lat, lng} 로 세팅된다.
}

/**
 * afterSetPano
 * @param {*} callback 
 * roadview.setPanoId()로 파노라마를 전환 완료한 시점 포착, finalizeRoadviewReady 호출
 * 
 */
function afterSetPano(callback){

    // 로드뷰 전환이 완료되는 시점에 한번만 불릴 onceResolve를 등록한다.
    // 전환이 끝나면 finalizeRoadviewReady(callback) 호출
    var resolved = false;
    function onceResolve(){
        if (resolved) return;
        resolved = true;
        rvInitialized = true;
        finalizeRoadviewReady(callback);
    }

    if (!rvInitialized){
        addListenerOnce(roadview, 'init', onceResolve);
    } else {
        addListenerOnce(roadview, 'panoid_changed', onceResolve);
        addListenerOnce(roadview, 'position_changed', onceResolve);
    }
}


/* ===== Random Helpers ===== */
// 지역 경계 내에서 임의의 위/경도 좌표를 생성해 반환한다.
function randomInBBox(bbox){
  // bbox = [minLat, minLng, maxLat, maxLng]
  var minLat = bbox[0], minLng = bbox[1], maxLat = bbox[2], maxLng = bbox[3];
  var lat = Math.random() * (maxLat - minLat) + minLat;
  var lng = Math.random() * (maxLng - minLng) + minLng;
  return new kakao.maps.LatLng(lat, lng);
}
// regions.json안의 모든 지역 목록 중 하나를 랜덤으로 선택한다.
function pickRandomRegion(){
  // regions.json을 못불러왔거나 비어있으면 null 반환
  // 뒤에서 null일 때 재시도 로직을 타게 됨
  if (!regions || !regions.length) return null;
  return regions[Math.floor(Math.random()*regions.length)];
}

/* ===== Reverse Geocoding (Admin labels) ===== */
function getRegionLabel(latlng, done){
  // 경도, 위도를 넣어서 행정구역 정보 목록을 가져온다. callback(result, status)로 응답을 받는다.
  geocoder.coord2RegionCode(latlng.getLng(), latlng.getLat(), function(result, status){
    // OK가 아니면 실패 처리
    if (status !== kakao.maps.services.Status.OK || !result || !result.length){
        done(''); return;
    } 
    // 행정동(B) 우선, 없으면 법정동(H)
    var b = null, h = null, i;
    for (i = 0; i < result.length; i++){
        if (result[i].region_type === 'B' && !b) b = result[i];
        if (result[i].region_type === 'H' && !h) h = result[i];
    }
    // 둘 다 없으면 result[0] 사용
    var r = b || h || result[0];

    var s1 = r.region_1depth_name || ''; // 시/도
    var s2 = r.region_2depth_name || ''; // 시/군/구
    var s3 = r.region_3depth_name || ''; // 동/읍/면
    
    // 항상 전체 라벨 표시
    var parts = [];
    if(s1.trim()) parts.push(s1); // 앞뒤 공백 제거
    if(s2.trim()) parts.push(s2); 
    if(s3.trim()) parts.push(s3); 

    done(parts.join(' '));

  });
}

/* ===== Find Roadview within a Region ===== */

function findRandomRoadviewInRegion(region, done){
  var maxPointAttempts = 8; // 이 지역에서 후보 포인트 최대 시도
  var radii = [50, 100, 200, 500, 1000];

  function tryOnePoint(attempt){
    // 다 써버리면 이 지역에선 실패로 간주하고 null => 다른 지역으로 넘어감.
    if (attempt >= maxPointAttempts) { done(null); return; }
    // seed 좌표 생성.
    var seed = randomInBBox(region.bbox);
    // seed 기준 원형 반경으로 로드뷰 탐색
    tryRadius(seed, 0, attempt);
  }
  
  // 반경 확장 : radii 순서로 점점 넓게 탐색한다.
  function tryRadius(seed, rIdx, attempt){
    // radius 이내에서 가장 가까운 panoId를 찾는다.
    roadviewClient.getNearestPanoId(seed, radii[rIdx], function(panoId){
      // 찾은 경우  
      if (panoId) {
        // 전환 완료 시점을 기다린다.
        // seed와 파노라마의 중심 좌표가 다를 수 있기 때문.
        // 로드뷰 컴포너트를 그 pano로 전환한 뒤 roadview.getPosition으로 읽는다.
        // 그걸로 진짜 좌표 설정.

        // 1. 먼저 이벤트 리스너 등록
        afterSetPano(function(res){
            done({
                latlng: res.latlng,
                panoId: panoId,
                label: res.label || region.region
            });
        });
        // 2. panoId를 설정해서 로드뷰 전환 시작. => aftersetPano
        roadview.setPanoId(panoId, seed);

      } else {
        // 반경 내에 없을 경우 다음 반경으로 커지며 반복.
        rIdx++;
        if (rIdx < radii.length) tryRadius(seed, rIdx, attempt);
        // 다 써도 안되면, 새 seed로 넘어가기
        else tryOnePoint(attempt + 1);
      }
    });
  }
  
  tryOnePoint(0);
}

/* ===== Pick Any Roadview (random region) ===== */
function pickRandomRoadview(done){
  // 지역 여러 번 바꿔가며 시도
  var maxRegionAttempts = 10;
  function tryRegion(n){
    // 최대 시도 횟수를 넘기면 null 반환
    if (n >= maxRegionAttempts) { done(null); return; }
    // 지역 선택
    var region = pickRandomRegion();
    if (!region) { done(null); return; }
    // 지역 내 roadview 설정, 추출 / 찾지 못하면 다른 지역으로 재시도
    findRandomRoadviewInRegion(region, function(res){
      if (res) done(res);
      else tryRegion(n+1);
    });
  }
  tryRegion(0);
}

// 결과 지도의 bound에 여유를 둠
function expandBounds(bounds, padMeters){
  var sw = bounds.getSouthWest();
  var ne = bounds.getNorthEast();
  var midLat = (sw.getLat() + ne.getLat()) / 2;

  var dLat = padMeters / 111320; // 위도 1도 ≈ 111.32km
  var dLng = padMeters / (111320 * Math.cos(midLat * Math.PI / 180));

  var swPad = new kakao.maps.LatLng(sw.getLat() - dLat, sw.getLng() - dLng);
  var nePad = new kakao.maps.LatLng(ne.getLat() + dLat, ne.getLng() + dLng);

  var padded = new kakao.maps.LatLngBounds();
  padded.extend(swPad);
  padded.extend(nePad);
  return padded;
}

function isInKorea(lat,lng){
  return lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132;
}

/* 지도 클릭 후 결과맵 render */
function renderResultMap(answerLatLng, guessLatLng){
  if(!resultMap){
    resultMap = new kakao.maps.Map(document.getElementById('resultMap'), {
      center: answerLatLng,
      level: 7
    });
  }

  // 이전 오버레이 정리
  for (var i = 0; i < resultMarkers.length; i++){
    resultMarkers[i].setMap(null);
  }
  resultMarkers = [];
  if (resultPolyline){resultPolyline.setMap(null); resultPolyline = null;}


  // 마커(정답)
  var answerIcon = new kakao.maps.MarkerImage(
    "https://t1.daumcdn.net/localimg/localimages/07/mapapidoc/markerStar.png",
    new kakao.maps.Size(24, 35),
    { offset: new kakao.maps.Point(12, 35)}
  );
  var answerMarker = new kakao.maps.Marker({
    position: answerLatLng,
    map: resultMap,
    image: answerIcon
  });
  var guessMarker = new kakao.maps.Marker({
    position: guessLatLng,
    map: resultMap
  });

  resultMarkers.push(answerMarker, guessMarker);

  // 두 점 연결선
  resultPolyline = new kakao.maps.Polyline({
    map: resultMap,
    path: [guessLatLng, answerLatLng],
    strokeWeight: 3,
    strokeOpacity: 0.85,
    strokeStyle: 'dash',
  });

  // 두 점 보이도록 지도 확장
  var bounds = new kakao.maps.LatLngBounds();
  bounds.extend(answerLatLng);
  bounds.extend(guessLatLng);
  // resultMap.setBounds(bounds);
  // bounds 적용 후 살짝 리레이아웃 (컨테이너 크기 변화 대비)
  //setTimeout(function(){if (resultMap && resultMap.relayout) resultMap.relayout(); }, 0);

  var distKm = haversineKm(
    answerLatLng.getLat(), answerLatLng.getLng(),
    guessLatLng.getLat(), guessLatLng.getLng()
  );

  if (resultMap.relayout) resultMap.relayout();

  // 레이아웃 반영을 한 프레임을 미뤄서 안정화
  setTimeout(function(){
    if (distKm < 0.1){
      // 100m 미만, 너무 가까우면 setBounds가 과도 줌을 만들 수 있어 고정 레벨 사용
      // 중간점 mid를 계산
      var mid = new kakao.maps.LatLng(
        (answerLatLng.getLat() + guessLatLng.getLat()) / 2,
        (answerLatLng.getLng() + guessLatLng.getLng()) / 2
      );
      resultMap.setCenter(mid);
      resultMap.setLevel(4, {animate: false});
    } else {
      // 여유 패딩 400m
      resultMap.setBounds(expandBounds(bounds, 400));
    }

    // 보험. 중심이 한국 밖이면 초기 뷰로 복귀
    var c = resultMap.getCenter();
    if (!isInKorea(c.getLat(), c.getLng())){
      resultMap.setCenter(INITIAL_MAP_CENTER);
      resultMap.setLevel(INITIAL_MAP_LEVEL, {animate:false});
    }
  }, 0);

}

/* 결과 UI 업데이트 */
function updateRoundResultUI(params){
  var roundEl = document.getElementById('roundResult');
  if (roundEl) roundEl.style.display = 'block';

  var titleEl = document.getElementById('roundTitle');
  if (titleEl) titleEl.innerText = 'Round ' + params.round;

  var pointEl = document.getElementById('roundPoint');
  if (pointEl) pointEl.innerText = params.pointsText;

  var distEl = document.getElementById('roundDistance');
  if (distEl) distEl.innerText = '정답 위치에서 ' + params.distanceText + ' 떨어졌습니다.';

  var gaugeEl = document.getElementById('roundGauge');
  if (gaugeEl) {
    var pct = Math.max(0, Math.min(100, params.gaugePercent));
    gaugeEl.style.width = pct + '%';
  }

  var locationEl = document.getElementById('roundLocation');
  if (locationEl) locationEl.innerText = '정답 : ' + (params.locationName || '-');
}



// 지도 클릭 후 마커 표시
function onMapClick(mouseEvent){
  if (!currentPlace){
    alert('로드뷰가 준비되는 중입니다. 잠시만 기다려주세요.');
    return;
  }

  // 찍은 좌표 보관
  pendingGuess = mouseEvent.latLng;
  // 지도에 마커 표시
  if (mapMarker) mapMarker.setMap(null);
  mapMarker = new kakao.maps.Marker({position: pendingGuess, map:map});

  // 추측/취소 버튼 보이기
  var bar = document.getElementById('guessBar');
  if (bar) bar.style.display = 'block';
}

// 추측하기 취소 버튼 핸들러
function clearGuess(){
  pendingGuess = null;
  if (mapMarker) {mapMarker.setMap(null); mapMarker = null;}

  var bar = document.getElementById('guessBar');
  if (bar) bar.style.display = 'none';
}

// 추측하기 버튼 핸들러
function submitGuess(){
  if (!currentPlace || !pendingGuess){
    alert('추측할 위치를 지도에 찍어주세요.');
    return;
  }

  var distKm = haversineKm(currentPlace.lat, currentPlace.lng, pendingGuess.getLat(), pendingGuess.getLng());
  var earned = scoreFromDistance(distKm);
  score += earned;
  updateHUD();

  // 결과 패널 UI 업데이트
  updateRoundResultUI({
    round: (round + 1),
    pointsText: earned.toLocaleString() + ' 포인트',
    distanceText: distKm.toFixed(2) + 'km',
    gaugePercent: (earned / SCORE_MAX) * 100,
    locationName: currentPlace.name
  });
  
  // 라운드 로그 저장
  roundLogs.push({
    round: round + 1,
    answer: {lat: currentPlace.lat, lng: currentPlace.lng, label: currentPlace.name || '-'},
    guess: {lat: pendingGuess.getLat(), lng: pendingGuess.getLng()},
    distKm: +distKm.toFixed(2),
    earned: earned
  });

  // 문제 화면 숨기기
  var gameArea = document.getElementById('gameArea');
  if (gameArea) gameArea.style.display = 'none';

  // 결과 map 띄우기
  renderResultMap(
    new kakao.maps.LatLng(currentPlace.lat, currentPlace.lng), // 정답
    pendingGuess                                                      // 추측
  );

  // 추측 버튼을 숨기고 상태 초기화
  var bar = document.getElementById('guessBar');
  if (bar) bar.style.display = 'none';
  pendingGuess = null;
}

/* ===== Round Flow ===== */
function startRound(){
  if (round >= GAME_MAX_ROUNDS) {
    return;
  }
  resetRoundState();

  pickRandomRoadview(function(res){
    if (!res) {
      // 전체 재시도 (로딩 실패 시)
      setTimeout(startRound, 300);
      return;
    }
    // 다음 라운드를 위한 상태 세팅 (행정구역 라벨만 노출)
    currentPlace = {
      name: res.label,
      lat: res.latlng.getLat(),
      lng: res.latlng.getLng()
    };
    // 로드뷰는 이미 setPanoId 되었고 init도 끝난 상태
    // 사용자 클릭만 기다리면 됨
  });
}

/* 라운드 시작 전 지도 오버레이/ 정답상태 초기화 */
function resetRoundState(){
  currentPlace = null;
  pendingGuess = null;
  if (mapMarker) {mapMarker.setMap(null); mapMarker = null;}

  var panel = document.getElementById('roundResult');
  if (panel) panel.style.display = 'none';

  var gameArea = document.getElementById('gameArea');
  if (gameArea) gameArea.style.display = '';
  
  var bar = document.getElementById('guessBar');
  if (bar) bar.style.display = 'none';

  if (map){
    map.setLevel(INITIAL_MAP_LEVEL, {animate:false});
    map.setCenter(INITIAL_MAP_CENTER);
    if (map.relayout) map.relayout();
  }
}


/* 라운드 증가 후 종료 / 다음 라운드 분기점 */
function nextRoundOrFinish(){
  if (round >= GAME_MAX_ROUNDS) {
    return false;
  }
  updateHUD();

  currentPlace = null;
  setTimeout(startRound, 600);
  return true;
} 


/* ===== Bootstrap ===== */
function initGeoGame(){
  // 로드뷰
  var rvEl = document.getElementById('roadview');
  if (!rvEl) { alert('#roadview 엘리먼트를 찾을 수 없습니다.'); return; }
  roadview = new kakao.maps.Roadview(rvEl);
  roadviewClient = new kakao.maps.RoadviewClient();

  // 지오코더
  geocoder = new kakao.maps.services.Geocoder();

  // 미니 지도
  var mapEl = document.getElementById('map');
  if (!mapEl) { alert('#map 엘리먼트를 찾을 수 없습니다.'); return; }
  map = new kakao.maps.Map(mapEl, {
    center: INITIAL_MAP_CENTER,
    level: INITIAL_MAP_LEVEL
  });
  // 지도에 예상되는 위치에 클릭하면 onMapClick 함수 실행
  kakao.maps.event.addListener(map, 'click', onMapClick);

  var btnSubmit = document.getElementById('btnSubmitGuess');
  if (btnSubmit) btnSubmit.addEventListener('click', function(e){
    e.preventDefault();
    submitGuess();
  });

  var btnClear = document.getElementById('btnClearGuess');
  if (btnClear) btnClear.addEventListener('click', function(e){
    e.preventDefault();
    clearGuess();
  });

  // 데이터 로드 후 시작
  loadRegions(function(){
    round = 0;
    score = 0;
    updateHUD();
    startRound();
  });

  var btnNext = document.getElementById('btnNextRound');
  if (btnNext) {
    btnNext.onclick = function(){
      round++;

      if (!nextRoundOrFinish()){
        showEndSummary();
        return;
      }

      var panel = document.getElementById('roundResult');
      var gameArea = document.getElementById('gameArea');
      if (panel) panel.style.display = 'none';
      if (gameArea) gameArea.style.display = '';
    }
  }

}

// 요약으로 넘어가는 함수
function showEndSummary(){
  var panel = document.getElementById('roundResult');
  if (panel) panel.style.display = 'none';
  var gameArea = document.getElementById('gameArea');
  if (gameArea) gameArea.style.display = 'none';

  // 총점
  var endScore = document.getElementById('endScore');
  if (endScore) endScore.innerText = '총점: ' + score.toLocaleString();

  // 라운드 로그 테이블 채우기
  var tbody = document.getElementById('roundLogTable');
  if (tbody){
    // 초기화
    while (tbody.firstChild) tbody.removeChild(tbody.firstChild);
    // 행 추가
    for (var i = 0; i< roundLogs.length; i++){
      var r = roundLogs[i];
      var tr = document.createElement('tr');
      tr.style.borderBottom = '1px solid #eee';

      var tdRound = document.createElement('td');
      tdRound.style.padding = '6px 4px'; tdRound.innerText = r.round;
      var tdAns = document.createElement('td');
      tdAns.style.padding = '6px 4px'; tdAns.innerText = r.answer.label;
      var tdDist = document.createElement('td');
      tdDist.style.padding = '6px 4px'; tdDist.innerText = r.distKm.toFixed(2) + "km";
      var tdScore = document.createElement('td');
      tdScore.style.padding = '6px 4px'; tdScore.innerText = r.earned.toLocaleString();

      tr.appendChild(tdRound); tr.appendChild(tdAns); tr.appendChild(tdDist); tr.appendChild(tdScore);
      tbody.appendChild(tr);
    }
  }
  // 요약 표시
  var end = document.getElementById('endSummary');
  if (end) end.style.display = 'block';

  // 지도 클릭 이벤트 삭제
  kakao.maps.event.removeListener(map, 'click', onMapClick);
}



// 자동 부트스트랩 (원하면 HTML에서 직접 initGeoGame() 호출해도 됨)
if (typeof window !== 'undefined') {
  window.addEventListener('load', function(){
    // Kakao SDK 로딩이 늦으면 약간 대기
    if (window.kakao && kakao.maps && kakao.maps.services) {
      initGeoGame();
    } else {
      var tries = 0;
      var id = setInterval(function(){
        tries++;
        if (window.kakao && kakao.maps && kakao.maps.services) {
          clearInterval(id);
          initGeoGame();
        } else if (tries > 50) { // ~5초
          clearInterval(id);
          alert('Kakao 지도 SDK 로딩에 실패했습니다.');
        }
      }, 100);
    }
  });
}



