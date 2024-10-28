import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as efs from 'aws-cdk-lib/aws-efs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

interface EcsStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  ecsSecurityGroup: ec2.SecurityGroup;
  albSecurityGroup: ec2.SecurityGroup;
  bedrockGatewaySecurityGroup: ec2.SecurityGroup;
  alb: elbv2.ApplicationLoadBalancer;
  targetGroup: elbv2.ApplicationTargetGroup;
  repository: ecr.Repository;
}

export class EcsStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props: EcsStackProps) {
    super(scope, id, props);

    // Create roles for OpenWebUI
    const taskRole = new iam.Role(this, 'OpenWebUITaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    const executionRole = new iam.Role(this, 'OpenWebUIExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Add task role permissions for EFS
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess'
      ],
      resources: ['*']  // Will be restricted to specific EFS ARN later
    }));

    // ECS Cluster
    const cluster = new ecs.Cluster(this, 'OpenWebUICluster', {
      vpc: props.vpc,
      containerInsights: true,
    });

    // Service Discovery Namespace for OpenWebUI
    const namespace = new servicediscovery.PrivateDnsNamespace(this, 'OpenWebUINamespace', {
      vpc: props.vpc,
      name: 'openwebui.local',
      description: 'Service discovery namespace for OpenWebUI services',
    });

    // Service Discovery Namespace for Bedrock Gateway
    const bedrockNamespace = new servicediscovery.PrivateDnsNamespace(this, 'BedrockNamespace', {
      vpc: props.vpc,
      name: 'bedrockforward.local',
      description: 'Service discovery namespace for Bedrock Access Gateway',
    });

    // Create Security Group for EFS
    const efsSecurityGroup = new ec2.SecurityGroup(this, 'EFSSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for EFS',
      allowAllOutbound: true,
    });

    // Allow NFS traffic from ECS Security Group to EFS
    efsSecurityGroup.addIngressRule(
      ec2.Peer.securityGroupId(props.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(2049),
      'Allow NFS access from ECS tasks'
    );

    // Create EFS File System
    const fileSystem = new efs.FileSystem(this, 'OpenWebUIEfs', {
      vpc: props.vpc,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      encrypted: true,
      securityGroup: efsSecurityGroup,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        onePerAz: true
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Add dependency check to ensure mount targets are created before ECS service
    const mountTargetParam = new ssm.StringParameter(this, 'EfsMountTargetCheck', {
      parameterName: '/efs/mount-targets-check',
      stringValue: fileSystem.fileSystemId,
    });

    // Update task role permissions with specific EFS ARN
    taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:ClientRootAccess'
      ],
      resources: [fileSystem.fileSystemArn]
    }));

    // Create Access Point for EFS
    const accessPoint = fileSystem.addAccessPoint('AccessPoint', {
      path: '/data',
      createAcl: {
        ownerUid: '1000',
        ownerGid: '1000',
        permissions: '755'
      },
      posixUser: {
        uid: '1000',
        gid: '1000'
      },
    });

    // Task Definition for OpenWebUI
    const openWebUITaskDef = new ecs.FargateTaskDefinition(this, 'OpenWebUITask', {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole: taskRole,
      executionRole: executionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64, // Changed to ARM64
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    //
    

    // Add permissions
    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    // Add EFS permissions to execution role
    executionRole.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: [
        'elasticfilesystem:ClientMount',
        'elasticfilesystem:ClientWrite',
        'elasticfilesystem:DescribeMountTargets'
      ],
      resources: [fileSystem.fileSystemArn]
    }));

    // EFS Volume Configuration
    openWebUITaskDef.addVolume({
      name: 'OpenWebUIEFSVolume',
      efsVolumeConfiguration: {
        fileSystemId: fileSystem.fileSystemId,
        transitEncryption: 'ENABLED',
        authorizationConfig: {
          accessPointId: accessPoint.accessPointId,
          iam: 'ENABLED',
        },
        rootDirectory: '/'
      },
    });

    // Container Definition for OpenWebUI
    const openWebUIContainer = openWebUITaskDef.addContainer('OpenWebUI', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, 'openwebui'),
      environment: {
        'OPENAI_API_BASE_URL': 'http://bedrock-gateway.bedrockforward.local/api/v1',
        'OPENAI_API_KEY': 'bedrock',
        // Add these settings
        'ENDPOINTS_CONFIG': JSON.stringify({
          'bedrock-gateway': {
            'url': 'http://bedrock-gateway.bedrockforward.local',
            'weight': 1,
            'retry_count': 2,
            'timeout': 90,
            'max_concurrent': 2
          }
        })
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'openwebui',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    openWebUIContainer.addPortMappings({
      containerPort: 8080,
      protocol: ecs.Protocol.TCP
    });

    // Mount EFS to the container
    openWebUIContainer.addMountPoints({
      containerPath: '/app/backend/data',
      sourceVolume: 'OpenWebUIEFSVolume',
      readOnly: false,
    });

    // Update ECS Service to depend on mount targets
    const openWebUIService = new ecs.FargateService(this, 'OpenWebUIService', {
      cluster,
      taskDefinition: openWebUITaskDef,
      desiredCount: 1,
      securityGroups: [props.ecsSecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS
      },
      cloudMapOptions: {
        cloudMapNamespace: namespace,
        name: 'open-webui',
      },
      maxHealthyPercent: 200,
      minHealthyPercent: 50,
    });

    // Add dependency
    openWebUIService.node.addDependency(mountTargetParam);

    // Attach to ALB
    openWebUIService.attachToApplicationTargetGroup(props.targetGroup);

    // --- Bedrock Access Gateway Configuration ---

    // Create roles for Bedrock Access Gateway
    const bedrockTaskRole = new iam.Role(this, 'BedrockAccessGatewayTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Attach AmazonBedrockFullAccess policy
    bedrockTaskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')
    );

    // Create execution role
    const bedrockExecutionRole = new iam.Role(this, 'BedrockAccessGatewayExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Attach ecsTaskExecutionRole policy to execution role
    bedrockExecutionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

    // Create task definition for Bedrock Access Gateway
    const bedrockTaskDef = new ecs.FargateTaskDefinition(this, 'BedrockAccessGatewayTaskDef', {
      memoryLimitMiB: 3072,
      cpu: 1024,
      taskRole: bedrockTaskRole,
      executionRole: bedrockExecutionRole,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64, // Changed to ARM64
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });
    

    // Add container definition
// Add container definition
const bedrockContainer = bedrockTaskDef.addContainer('BedrockAccessGatewayContainer', {
  image: ecs.ContainerImage.fromEcrRepository(props.repository, 'bedrock-gateway'),
  logging: ecs.LogDrivers.awsLogs({
    streamPrefix: 'bedrock-access-gateway',
    logRetention: logs.RetentionDays.ONE_WEEK,
  }),
  environment: {
    'BOTO3_CONFIG_MAX_RETRIES': '2',
    'BOTO3_CONFIG_RETRY_MODE': 'adaptive',
    'BEDROCK_MAX_CONCURRENT_REQUESTS': '3',
    'BEDROCK_REQUESTS_PER_MINUTE': '10',
  }
});

    bedrockContainer.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP,
    });

    // Create ECS service for Bedrock Access Gateway
    const bedrockService = new ecs.FargateService(this, 'BedrockAccessGatewayService', {
      cluster,
      taskDefinition: bedrockTaskDef,
      desiredCount: 1,
      securityGroups: [props.bedrockGatewaySecurityGroup],
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      cloudMapOptions: {
        cloudMapNamespace: bedrockNamespace,
        name: 'bedrock-gateway',
      },
    });

    // Output the File System ID
    new cdk.CfnOutput(this, 'FileSystemId', {
      value: fileSystem.fileSystemId,
      description: 'EFS File System ID',
      exportName: 'efsFileSystemId'
    });
  }
}
