<?php
declare(strict_types=1);
// Presentation fixture only; cannot confirm an order or grant membership.
if (PHP_SAPI!=='cli-server' || getenv('MOONYA_PAYMENT_RETURN_PAGE_TEST')!=='1' || !in_array($_SERVER['REMOTE_ADDR']??'',['127.0.0.1','::1'],true)) {http_response_code(404);exit;}
require_once dirname(__DIR__).'/Services/PaymentReturnPage.php';
header('Cache-Control: no-store');header('Referrer-Policy: no-referrer');
$state=$_GET['state']??'invalid';
if (!in_array($state,['paid','pending','closed','invalid','unavailable'],true)) {http_response_code(400);exit;}
paymentReturnPage($state,'MYfixture0000000001');
