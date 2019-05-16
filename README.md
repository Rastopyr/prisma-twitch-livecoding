# prisma-twitch-livecoding-16.05.19
Result of livecoding stream from Twitch

## How to start

```
# run containers of postgres and prisma with docker-compose
docker-compose up -d

# deploy prisma schema
yarn prisma:deploy

# run public server
yarn start
```
