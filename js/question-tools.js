/* Mathside question presentation helpers. No score or answer-key changes. */
(function (root) {
  'use strict';
  function hashString(value) {
    let h = 2166136261;
    for (const char of String(value || '')) {
      h ^= char.charCodeAt(0);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function randomFrom(seed) {
    let s = seed >>> 0;
    return function () {
      s += 0x6D2B79F5;
      let t = s;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffleArray(rows, seed) {
    const copy = rows.slice();
    const rng = randomFrom(hashString(seed));
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }
  function studentQuestionOrder(questions, assignmentId, studentId, enabled) {
    // Student + assignment make a repeatable order across refreshes, drafts and resubmissions.
    if (!enabled || questions.length < 2 || !studentId) return questions.slice();
    return shuffleArray(questions, `mathside-qorder-v1|${assignmentId}|${studentId}`);
  }
  function studentOptionOrder(question, assignmentId, studentId) {
    // Shuffle within ONE question. Including question.id prevents distractors
    // moving between questions or being associated with the wrong answer key.
    const options = Array.isArray(question?.options) ? question.options.slice() : [];
    if (options.length < 2 || !question?.id || !assignmentId || !studentId) return options;
    return shuffleArray(options, `mathside-option-order-v1|${assignmentId}|${question.id}|${studentId}`);
  }
  function parseNumber(text) {
    const value = String(text || '').trim().replace(/,/g, '');
    const fraction = value.match(/^(-?\d+)\s*\/\s*(-?\d+)$/);
    if (fraction && +fraction[2] !== 0) return +fraction[1] / +fraction[2];
    const plain = value.match(/^(?:x\s*=\s*)?([+-]?(?:\d+(?:\.\d*)?|\.\d+))$/i);
    return plain ? +plain[1] : null;
  }
  function formatNumber(n, original) {
    if (!Number.isFinite(n)) return '';
    const fixed = +n.toFixed(4);
    if (original && /^\s*[+-]?\d+\s*\/\s*\d+\s*$/i.test(original)) {
      const v = Math.round(fixed * 1000);
      for (let denom = 2; denom <= 20; denom++) {
        const num = Math.round(fixed * denom);
        if (Math.abs(num / denom - fixed) < 0.00001) return `${num}/${denom}`;
      }
    }
    return /^\s*x\s*=/i.test(original || '') ? `x = ${fixed}` : String(fixed);
  }
  function getMathExpressions(question) {
    return String(question || '')
      .replace(/\\times|\\cdot/g, '*').replace(/[×·]/g, '*')
      .replace(/[÷]/g, '/').replace(/\u2212/g, '-')
      .replace(/[?]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function buildSuggestion(questionText, correctAnswer) {
    const correct = String(correctAnswer || '').trim();
    const question = getMathExpressions(questionText);
    if (!correct || !question) return { ok: false, reason: 'Enter the question and its correct answer first.' };
    const number = parseNumber(correct);
    let candidates = [];
    let reason = '';
    if (number !== null && Number.isFinite(number)) {
      const flat = question.replace(/\s+/g, '');
      // One-step/two-step linear equations: ax + b = c.
      const equation = flat.match(/([+-]?\d*(?:\.\d+)?)x([+-]\d+(?:\.\d+)?)?=([+-]?\d+(?:\.\d+)?)(?:$|[^\d.])/i);
      if (equation) {
        const coefficient = equation[1] === '-' ? -1 : equation[1] === '' || equation[1] === '+' ? 1 : +equation[1];
        const constant = +(equation[2] || 0);
        const right = +equation[3];
        const solved = (right - constant) / coefficient;
        if (coefficient === 0 || Math.abs(solved - number) > 0.0001) return { ok: false, reason: 'The correct answer does not match the equation. Check the answer key first.' };
        candidates = [(right + constant) / coefficient, right - constant, right / coefficient, (right - constant) / -coefficient, right + constant];
        reason = 'Common equation-solving mistakes (signs, moving terms, division)';
      }
      // Arithmetic statistics: use common mean/median/range mistakes as distractors.
      if (!candidates.length && /\b(mean|average|arithmetic mean)\b/i.test(question)) {
        const quantities = question.match(/-?\d+(?:\.\d+)?/g)?.map(Number) || [];
        if (quantities.length >= 3 && quantities.length <= 15) {
          const sum = quantities.reduce((a, b) => a + b, 0);
          const mean = sum / quantities.length;
          if (Math.abs(mean - number) <= 0.02) {
            const sorted = quantities.slice().sort((a, b) => a - b);
            const mid = Math.floor(sorted.length / 2);
            const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
            candidates = [median, sum, Math.max(...quantities) - Math.min(...quantities), sum / (quantities.length - 1), sum / (quantities.length + 1)];
            reason = 'Common mistakes with the mean, median, range, and number of values';
          }
        }
      }
      // Basic expression with two numbers (including a visible calculation in a word problem).
      if (!candidates.length) {
        const expression = flat.match(/([+-]?\d+(?:\.\d+)?)([+*/-])([+-]?\d+(?:\.\d+)?)/);
        if (expression) {
          const a = +expression[1], b = +expression[3];
          const operation = expression[2];
          const actual = operation === '+' ? a + b : operation === '-' ? a - b : operation === '*' ? a * b : b ? a / b : NaN;
          if (Number.isFinite(actual) && Math.abs(actual - number) < 0.0001) {
            candidates = [a + b, a - b, a * b, b ? a / b : NaN, b - a, number * -1];
            reason = 'Common operation mistakes';
          }
        }
      }
      if (!candidates.length) {
        // Numeric distractors are suggestions, not a claim of semantic correctness.
        const step = Math.abs(number) < 1 ? 0.25 : Number.isInteger(number) ? 1 : 0.5;
        candidates = [number + step, number - step, -number, number + 2 * step, number - 2 * step, number * 2, number / 2];
        reason = 'Nearby numerical answers (review mathematical plausibility)';
      }
      // The correct answer belongs to the TEACHER, not the suggestion engine.
      // Return only three distinct, incorrect distractors for A-C.
      const values = [];
      candidates.map(n => formatNumber(n, correct)).filter(Boolean).forEach(value => {
        if (values.length < 3 && parseNumber(value) !== number && !values.some(item => item.toLowerCase() === value.toLowerCase())) values.push(value);
      });
      let k = 1;
      while (values.length < 3 && k <= 8) {
        const candidate = formatNumber(number + (k * (number < 0 ? -1 : 1)), correct);
        if (!values.includes(candidate)) values.push(candidate);
        k += 1;
      }
      if (values.length !== 3) return { ok: false, reason: 'Could not generate three distinct incorrect choices. Add them manually.' };
      return { ok: true, distractors: shuffleArray(values, `distractors|${question}|${correct}`), reason };
    }
    // Closed-domain conceptual terms; never fabricate distractors for arbitrary prose.
    const categories = [
      ['mean', 'median', 'mode', 'range'],
      ['linear', 'quadratic', 'exponential', 'logarithmic'],
      ['addition', 'subtraction', 'multiplication', 'division'],
      ['integer', 'rational', 'irrational', 'natural'],
      ['acute', 'obtuse', 'right', 'straight'],
      ['true', 'false']
    ];
    const group = categories.find(items => items.includes(correct.toLowerCase()) && (items.some(item => question.toLowerCase().includes(item)) || /which|identify|classify|type|measure|statement|property/i.test(question)));
    if (group && group.length >= 4) {
      const distractors = group.filter(item => item !== correct.toLowerCase()).map(item => item.charAt(0).toUpperCase() + item.slice(1));
      if (distractors.length === 3) return { ok: true, distractors: shuffleArray(distractors, `distractors-concept|${question}|${correct}`), reason: 'Related concepts from a supported mathematics category' };
    }
    if (group && group.length < 4) return { ok: false, reason: 'True/False has only two valid choices. Enter those two manually instead of generating three incorrect options.' };
    return { ok: false, reason: 'This answer needs teacher-written choices. Automatic suggestions support numerical mathematics and selected concept categories; no unverified choices were generated.' };
  }
  root.MathsideQuestionTools = { studentQuestionOrder, studentOptionOrder, buildSuggestion, shuffleArray };
})(typeof window !== 'undefined' ? window : globalThis);
