var questions = [];
var idx = 0;
var score = 0;
var answered = false;

function decodeHtml(str) {
  var txt = document.createElement('textarea');
  txt.innerHTML = str;
  return txt.value;
}

function shuffle(arr) {
  for (var i = arr.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function buildUrl() {
  var amount = document.getElementById('amount').value || 5;
  var cat = document.getElementById('category').value;
  var diff = document.getElementById('difficulty').value;

  var url = 'https://opentdb.com/api.php?amount=' + encodeURIComponent(amount) + '&type=multiple';
  if (cat) { url += '&category=' + encodeURIComponent(cat); }
  if (diff) { url += '&difficulty=' + encodeURIComponent(diff); }
  return url;
}

function fetchQuestions(callback) {
  var xhr = new XMLHttpRequest();
  xhr.open('GET', buildUrl(), true);
  xhr.onreadystatechange = function () {
    if (xhr.readyState === 4) {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          var data = JSON.parse(xhr.responseText);
          callback(null, data && data.results ? data.results : []);
        } catch (e) {
          callback(e);
        }
      } else {
        callback(new Error('HTTP ' + xhr.status));
      }
    }
  };
  xhr.send();
}

function updateHUD() {
  var progress = (idx + 1) + ' / ' + questions.length;
  document.getElementById('progress').textContent = progress;
  document.getElementById('score').textContent = String(score);
}

function renderQuestion() {
  var q = questions[idx];
  var qElem = document.getElementById('question');
  var answersDiv = document.getElementById('answers');
  var nextBtn = document.getElementById('nextBtn');

  if (!q) {
    qElem.textContent = '끝! 최종 점수: ' + score + ' / ' + questions.length;
    answersDiv.innerHTML = '';
    nextBtn.style.display = 'none';
    document.getElementById('restartBtn').style.display = 'inline-block';
    return;
  }

  answered = false;
  qElem.textContent = decodeHtml(q.question);

  var all = q.incorrect_answers.slice(0);
  all.push(q.correct_answer);
  shuffle(all);

  answersDiv.innerHTML = '';
  for (var i = 0; i < all.length; i++) {
    (function (a) {
      var btn = document.createElement('button');
      btn.textContent = decodeHtml(a);
      btn.onclick = function () {
        if (answered) { return; }
        answered = true;
        if (a === q.correct_answer) {
          score++;
          btn.classList.add('is-correct');
        } else {
          btn.classList.add('is-wrong');
          // 정답 표시
          var children = answersDiv.children;
          for (var k = 0; k < children.length; k++) {
            if (children[k].textContent === decodeHtml(q.correct_answer)) {
              children[k].style.border = '2px solid green';
            } else {
              children[k].style.border = '2px solid red';
          }
        }
        document.getElementById('score').textContent = String(score);
        nextBtn.style.display = 'inline-block';
      };
      answersDiv.appendChild(btn);
    })(all[i]);
  }

  updateHUD();
  nextBtn.style.display = 'none';
}

// 이벤트 바인딩
document.getElementById('startBtn').onclick = function () {
  score = 0; idx = 0;
  document.getElementById('restartBtn').style.display = 'none';
  fetchQuestions(function (err, list) {
    if (err) {
      alert('문제를 불러오지 못했습니다.');
      return;
    }
    questions = list;
    if (!questions.length) {
      alert('문제를 불러오지 못했습니다.');
      return;
    }
    renderQuestion();
  });
};

document.getElementById('nextBtn').onclick = function () {
  idx++;
  renderQuestion();
};

document.getElementById('restartBtn').onclick = function () {
  score = 0; idx = 0; questions = [];
  document.getElementById('question').textContent = '시작을 누르면 문제가 표시됩니다.';
  document.getElementById('answers').innerHTML = '';
  document.getElementById('progress').textContent = '0 / 0';
  document.getElementById('score').textContent = '0';
  document.getElementById('restartBtn').style.display = 'none';
};


