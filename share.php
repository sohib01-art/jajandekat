<?php
// Preview link artikel untuk WhatsApp/Facebook/Telegram.
// Dipanggil oleh .htaccess hanya saat yang membuka adalah bot pembuat preview.
$SUPABASE_URL = 'https://lzcvykadtpqiqaebmmbh.supabase.co';
$ANON_KEY     = 'sb_publishable_Vz1L0V8bFb__gnqMRosztQ_GMsZHrNo'; // kunci publik (publishable)
$SITE         = 'https://jajandekat.my.id';

$slug = isset($_GET['artikel']) ? strtolower(trim($_GET['artikel'])) : '';
if (!preg_match('/^[a-z0-9-]{1,200}$/', $slug)) { header('Location: ' . $SITE . '/'); exit; }

$api = $SUPABASE_URL . '/rest/v1/articles?select=title,excerpt,meta_description,cover_image'
     . '&status=eq.published&slug=eq.' . rawurlencode($slug) . '&limit=1';
$ctx = stream_context_create(['http' => [
  'timeout' => 5,
  'header'  => "apikey: $ANON_KEY\r\nAuthorization: Bearer $ANON_KEY\r\n",
]]);
$json = @file_get_contents($api, false, $ctx);
$rows = $json ? json_decode($json, true) : null;

// Artikel tidak ada / belum published -> arahkan ke beranda
if (!is_array($rows) || !count($rows)) { header('Location: ' . $SITE . '/'); exit; }

$a     = $rows[0];
$h     = fn($s) => htmlspecialchars((string)$s, ENT_QUOTES, 'UTF-8');
$title = $a['title'] . ' | JajanDekat';
$desc  = $a['excerpt'] ?: $a['meta_description'] ?: 'Temukan pedagang keliling terdekat di JajanDekat.';
$img   = $a['cover_image'] ?: ($SITE . '/icon-512.png'); // ganti ke logo bila perlu
$url   = $SITE . '/?artikel=' . rawurlencode($slug);

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: public, max-age=300');
?><!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<title><?= $h($title) ?></title>
<meta name="description" content="<?= $h($desc) ?>">
<meta property="og:type" content="article">
<meta property="og:site_name" content="JajanDekat">
<meta property="og:title" content="<?= $h($a['title']) ?>">
<meta property="og:description" content="<?= $h($desc) ?>">
<meta property="og:image" content="<?= $h($img) ?>">
<meta property="og:url" content="<?= $h($url) ?>">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="<?= $h($url) ?>">
</head>
<body><a href="<?= $h($url) ?>"><?= $h($a['title']) ?></a></body>
</html>
