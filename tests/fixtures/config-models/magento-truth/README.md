What Magento itself reads from this fixture — generated with `scripts/verify-magento/fixture-truth.php`
(Magento's readers and converters on the fixture's files) in Mage-OS 2.4.9 / PHP 8.3:

```bash
docker cp tests/fixtures/config-models <container>:/tmp/cm
docker cp scripts/verify-magento/fixture-truth.php <container>:/tmp/
for k in webapi graphql cron dbschema; do
  docker exec -u www-data -w /var/www/html <container> php /tmp/fixture-truth.php /var/www/html /tmp/cm $k \
    > tests/fixtures/config-models/magento-truth/$k.json
done
```

Regenerate after changing the fixture; `tests/config-models.test.js` compares Magector with these files.
