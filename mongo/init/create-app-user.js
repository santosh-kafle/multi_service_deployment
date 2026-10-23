// Runs once, on first start with an empty data volume. Creates the user the API connects as.
db.getSiblingDB(process.env.MONGO_DB).createUser({
  user: process.env.MONGO_APP_USERNAME,
  pwd: process.env.MONGO_APP_PASSWORD,
  roles: [{ role: "readWrite", db: process.env.MONGO_DB }],
});
