const origin = window.location.origin;
const base = origin === 'null' ? 'https://proxy.example.com' : origin;

for (const element of document.querySelectorAll('[data-base]')) {
  element.textContent = base + element.dataset.base;
}

// No keys are collected and no API requests are made by this page.
const examples = {
  gemini: {
    filename: 'gemini.sh',
    note: 'Задайте GEMINI_API_KEY и GEMINI_MODEL в окружении. Идентификатор модели возьмите из каталога Gemini.',
    code: `curl "${base}/gemini/v1beta/models/$GEMINI_MODEL:generateContent" \\
  -H "x-goog-api-key: $GEMINI_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "contents": [{
      "parts": [{
        "text": "Объясни SSE в двух предложениях"
      }]
    }]
  }'`
  },
  openrouter: {
    filename: 'openrouter.sh',
    note: 'Задайте OPENROUTER_API_KEY и OPENROUTER_MODEL в окружении. Например, OPENROUTER_MODEL=провайдер/модель из каталога OpenRouter.',
    code: `curl "${base}/openrouter/chat/completions" \\
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\n    \\"model\\": \\"$OPENROUTER_MODEL\\",\n    \\"messages\\": [{\n      \\"role\\": \\"user\\",\n      \\"content\\": \\"Explain SSE in two sentences\\"\n    }]\n  }"`
  },
  python: {
    filename: 'example.py',
    note: 'Установите SDK: pip install openai. Задайте OPENROUTER_API_KEY и OPENROUTER_MODEL в переменных окружения.',
    code: `import os
from openai import OpenAI

client = OpenAI(
    base_url="${base}/openrouter",
    api_key=os.environ["OPENROUTER_API_KEY"],
)

response = client.chat.completions.create(
    model=os.environ["OPENROUTER_MODEL"],
    messages=[{
        "role": "user",
        "content": "Объясни SSE в двух предложениях",
    }],
)

print(response.choices[0].message.content)`
  },
  stream: {
    filename: 'stream.sh',
    note: 'Флаг -N отключает буферизацию cURL. Ответ приходит в формате SSE; параметр stream включает потоковую выдачу у провайдера.',
    code: `curl -N "${base}/openrouter/chat/completions" \\
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d "{\n    \\"model\\": \\"$OPENROUTER_MODEL\\",\n    \\"stream\\": true,\n    \\"messages\\": [{\n      \\"role\\": \\"user\\",\n      \\"content\\": \\"Write a short story about a lighthouse\\"\n    }]\n  }"`
  }
};

const code = document.querySelector('#example-code');
const filename = document.querySelector('#example-filename');
const note = document.querySelector('#example-note');
const status = document.querySelector('#copy-status');
const choices = document.querySelectorAll('[data-example]');

function showExample(name) {
  const example = examples[name];
  code.textContent = example.code;
  filename.textContent = example.filename;
  note.textContent = example.note;
  code.parentElement.scrollLeft = 0;
  status.textContent = '';
  for (const choice of choices) {
    const active = choice.dataset.example === name;
    choice.classList.toggle('active', active);
    choice.setAttribute('aria-pressed', String(active));
  }
}

for (const choice of choices) {
  choice.addEventListener('click', () => showExample(choice.dataset.example));
}

document.querySelector('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(code.textContent);
    status.textContent = 'Пример скопирован. Не забудьте задать API-ключ и модель.';
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = 'Не удалось скопировать автоматически. Код выделен — скопируйте его вручную.';
  }
});

showExample('gemini');
