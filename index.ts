import { GraphQLServer, PubSub } from "graphql-yoga";
import { sign, verify } from "jsonwebtoken";

import { GraphQLScalarType } from "graphql";
import { Kind } from "graphql/language";

import { shield, rule, and } from "graphql-shield";
import { prisma } from "./generated/prisma-client/index";

const typeDefs = `
  scalar Date

  type Conversation {
    id: ID!

    title: String! 
    startedAt: Date! 

    disabled: Boolean!

    participants: [User!]!
    message: [Message!]!
  }

  type Message {
    id: ID!

    body: String!
    createdAt: Date!

    conversation: Conversation!
    author: User!
  }

  type User {
    id: ID!

    nickname: String!

    conversations: [Conversation]!
    messages: [Message]!
  }

  type SignInUserResponse {
    id: ID!
    nickname: String!
  }
  
  type SignInResponse {
    user: SignInUserResponse!
    token: String!
  }

  type Query {
    me: User!
  }

  type Mutation {
    signin(nickname: String!): SignInResponse!

    sendMessage(body: String!, conversation: ID!): Message!
    joinToConversation(conversation: ID!): Conversation!
  }

  type Subscription {
    message(conversation: ID!): Message!
  }
`;

const getUser = async (req) => {
  const authorization = req.get("Authorization");

  if (!authorization) {
    // throw new Error(`Not authenticated`);
    return null;
  }

  const token = authorization.replace("Bearer ", "");

  const { id } = verify(token, process.env.APP_SECRET);
  const meIsExists = await prisma.$exists.user({ id });

  if (!meIsExists) {
    // throw new Error(`User not exists`);
    return null;
  }

  return await prisma.user({ id });
};

const existsUserInConv = async ({ userId, conversationId, prisma }) => {
  const participants = await prisma
    .conversation({ id: conversationId })
    .participants();

  return participants.some(({ id }) => userId === id);
};

const isAuthenticated = rule()(async (parent, args, ctx) => {
  return ctx.user != null;
});

const haveUserAccessToConv = rule()(async (parent, args, ctx) => {
  const { conversation: conversationId } = args;
  const { user, prisma } = ctx;

  return await existsUserInConv({ prisma, userId: user.id, conversationId });
});

const permissions = shield({
  Query: {
    me: isAuthenticated
  },

  Mutation: {
    sendMessage: and(isAuthenticated, haveUserAccessToConv),
    joinToConversation: isAuthenticated
  },

  Subscription: {
    message: and(isAuthenticated, haveUserAccessToConv)
  },

  User: {
    conversations: isAuthenticated,
    messages: isAuthenticated
  }
});

const resolvers = {
  Query: {
    async me(_parent, _args, { req, user }, info) {
      return user;
    }
  },

  Mutation: {
    async joinToConversation(
      _,
      { conversation: conversationId },
      { user, prisma }
    ) {
      const isExistsInConv = existsUserInConv({
        conversationId,
        userId: user.id,
        prisma
      });

      if (!isExistsInConv) {
        return await prisma.updateConversation({
          where: {
            id: conversationId
          },

          data: {
            participants: {
              connect: {
                id: user.id
              }
            }
          }
        });
      }

      return await prisma.conversation({ id: conversationId });
    },

    async sendMessage(_, { conversation, body }, { user }) {
      const message = await prisma.createMessage({
        author: {
          connect: {
            id: user.id
          }
        },

        conversation: {
          connect: {
            id: conversation
          }
        },

        body
      });

      pubsub.publish(conversation, { message });

      return message;
    },

    async signin(_, { nickname }) {
      const isExistsUser = await prisma.$exists.user({
        nickname
      });

      let user;

      if (isExistsUser) {
        user = await prisma.user({
          nickname
        });
      } else {
        user = await prisma.createUser({
          nickname
        });
      }

      const token = sign({ id: user.id, nickname }, process.env.APP_SECRET);

      return {
        user,
        token
      };
    }
  },

  Subscription: {
    message: {
      async subscribe(_, { conversation: conversationId }, { user, pubsub }) {
        return pubsub.asyncIterator(conversationId);
      }
    }
  },

  Date: new GraphQLScalarType({
    name: "Date",
    description: "Date custom scalar type",
    parseValue(value) {
      return new Date(value); // value from the client
    },
    serialize(value) {
      if (typeof value === "string") {
        return value;
      }

      return value.getTime(); // value sent to the client
    },
    parseLiteral(ast) {
      if (ast.kind === Kind.INT) {
        return new Date(ast.value); // ast value is always in string format
      }
      return null;
    }
  }),

  User: {
    async conversations(parent) {
      return await prisma.conversations({
        where: {
          participants_some: {
            id: parent.id
          }
        }
      });
    },

    async messages(parent) {
      return await prisma.messages({
        where: {
          author: {
            id: parent.id
          }
        }
      });
    }
  },

  Message: {}
};

const pubsub = new PubSub();
const server = new GraphQLServer({
  typeDefs,
  resolvers,
  middlewares: [permissions],
  context: async ({ request, connection }) => {
    if (connection) {
      return {
        request,
        user: await getUser({
          get(headerName) {
            return connection.context[headerName];
          }
        }),
        prisma,
        pubsub
      };
    }

    return {
      request,
      user: await getUser(request),
      prisma,
      pubsub
    };
  }
});

server.start(() => console.log("Server is running on localhost:4000"));
