import { GraphQLServer } from "graphql-yoga";
import { sign, verify } from "jsonwebtoken";

import { GraphQLScalarType } from "graphql";
import { Kind } from "graphql/language";

import { prisma, Conversation } from "./generated/prisma-client/index";
import { shield, rule } from "graphql-shield";

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
`;

const getUser = async (req) => {
  const authorization = req.get("Authorization");

  if (!authorization) {
    throw new Error(`Not authenticated`);
  }

  const token = authorization.replace("Bearer ", "");

  const { id } = verify(token, process.env.APP_SECRET);
  const meIsExists = await prisma.$exists.user({ id });

  if (!meIsExists) {
    throw new Error(`User not exists`);
  }

  return await prisma.user({ id });
};

const isAuthenticated = rule()(async (parent, args, ctx, info) => {
  return ctx.user !== null;
});

const permissions = shield({
  Query: {
    me: isAuthenticated
  },

  Mutation: {
    sendMessage: isAuthenticated,
    joinToConversation: isAuthenticated
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
    async joinToConversation(_, { conversation }, { user }, info) {
      const participants = await prisma
        .conversation({ id: conversation })
        .participants();
      const existedInConv = participants.find(({ id }) => user.id);

      if (!existedInConv) {
        return await prisma.updateConversation({
          where: {
            id: conversation
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

      return;
    },

    async sendMessage(_, { conversation, body }, { user }, info) {
      const message = await prisma.createMessage({
        author: {
          connect: {
            id: user.id
          }
        },

        conversation: {
          connect: {
            id: conversation.id
          }
        },

        body
      });

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

  Date: new GraphQLScalarType({
    name: "Date",
    description: "Date custom scalar type",
    parseValue(value) {
      return new Date(value); // value from the client
    },
    serialize(value) {
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
  }
};

const server = new GraphQLServer({
  typeDefs,
  resolvers,
  middlewares: [permissions],
  context: ({ request }) => ({ request, user: getUser(request) })
});

server.start(() => console.log("Server is running on localhost:4000"));
