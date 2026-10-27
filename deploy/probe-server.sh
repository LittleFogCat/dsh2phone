echo '=== docker-compose.yml ==='
cat /usr/local/compose/docker-compose.yml
echo
echo '=== conf tree ==='
find /usr/local/compose/conf -maxdepth 3 -type f
echo
echo '=== nginx conf files ==='
for f in $(find /usr/local/compose/conf/nginx -type f); do
  echo "----- $f -----"
  cat "$f"
done
echo
echo '=== nginx container mounts ==='
docker inspect nginx --format '{{json .Mounts}}'
echo
echo '=== cert coverage ==='
for c in $(find /usr/local/compose/conf -name '*.pem' -o -name '*.crt' -o -name 'fullchain*' 2>/dev/null); do
  echo "----- $c -----"
  openssl x509 -in "$c" -noout -subject -issuer -dates -ext subjectAltName 2>/dev/null || echo '(not a cert)'
done
echo
echo '=== listening ports ==='
ss -tlnp | head -20
echo
echo '=== mem ==='
free -h
