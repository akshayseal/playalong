const { parse } = require('csv-parse/sync');

// Expected CSV header (case-insensitive, order-insensitive):
// question, option_a, option_b, option_c, option_d, correct_option, image_url, time_limit_seconds, points_base
//
// - correct_option must be A, B, C or D
// - image_url is optional (leave blank for text-only questions)
// - time_limit_seconds / points_base are optional, default to 20 / 1000

function parseQuestionsCsv(buffer) {
  const rows = parse(buffer, {
    columns: (header) => header.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_')),
    skip_empty_lines: true,
    trim: true,
  });

  const errors = [];
  const questions = [];

  rows.forEach((row, i) => {
    const lineNo = i + 2; // +1 for header, +1 for 1-index
    const required = ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct_option'];
    const missing = required.filter((f) => !row[f]);
    if (missing.length) {
      errors.push(`Row ${lineNo}: missing ${missing.join(', ')}`);
      return;
    }
    const correct = row.correct_option.trim().toUpperCase();
    if (!['A', 'B', 'C', 'D'].includes(correct)) {
      errors.push(`Row ${lineNo}: correct_option must be A/B/C/D, got "${row.correct_option}"`);
      return;
    }
    questions.push({
      question_text: row.question,
      option_a: row.option_a,
      option_b: row.option_b,
      option_c: row.option_c,
      option_d: row.option_d,
      correct_option: correct,
      image_url: row.image_url || null,
      time_limit_seconds: row.time_limit_seconds ? parseInt(row.time_limit_seconds, 10) : 20,
      points_base: row.points_base ? parseInt(row.points_base, 10) : 1000,
    });
  });

  return { questions, errors };
}

module.exports = { parseQuestionsCsv };
